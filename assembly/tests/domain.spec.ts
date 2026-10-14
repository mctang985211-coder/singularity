import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { runVerifierSelftest } from '../../src/verifier/implementation.ts'
import { asyncRefusalOf, refusalOf } from '../../tests/fixtures.ts'
import { loadDomain, templateOf } from '../src/domain.ts'
import { spawnProcess } from '../src/process.ts'

const REAL = fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url))
const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const scratch: string[] = []
afterEach(async () => { await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

function declaration() {
  return {
    rootTemplate: 'root',
    inputs: [{ ref: 'material', from: 'pass.txt' }],
    templates: [{ id: 'root', goal: 'count the protected material',
      input: { name: 'in/source.txt', source: { kind: 'protected', ref: 'material' } },
      workspace: { artifact: 'report.txt' },
      criterion: { criterionId: 'counted', statement: 'the report is the count', verifier: 'count' },
      },
    ],
    verifiers: [{ ref: 'count', version: '1', program: 'verifier.mjs', args: ['{artifact}', '{input}'],
      selftest: [{ name: 'correct', expected: 'pass', artifact: 'pass.txt', argv: ['pass.txt', 'pass.txt'] },
        { name: 'wrong', expected: 'fail', artifact: 'fail.txt', argv: ['fail.txt', 'pass.txt'] },
        ],
      },
    ],
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

describe('the deployment domain', () => {
  it('reads every domain string from the declared file, digesting the verifier bytes', async () => {
    const declared = declaration()
    const dir = await fixture(declared)
    const domain = await loadDomain(dir, spawnProcess)
    const root = domain.templates.get(domain.rootTemplate)!
    expect([domain.rootTemplate, root.goal, root.input, root.artifact]).toEqual([
      'root', declared.templates[0]!.goal, declared.templates[0]!.input,
      'report.txt',
    ])
    expect([root.check!.verifierRef, root.check!.implementationDigest, domain.inputs[0]!.digest]).toEqual([
      'count', sha256(await readFile(join(dir, 'verifier.mjs'))), sha256('abc'),
    ])
  })

  it('keeps a template identity independent of unrelated templates and changes it with its own declaration or verifier bytes', async () => {
    const declared = declaration()
    const dir = await fixture(declared)
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

  it.each(['version', 'args'] as const)('changes a template identity when its verifier %s changes', async (field) => {
    const declared = declaration()
    const dir = await fixture(declared)
    const first = (await loadDomain(dir, spawnProcess)).templates.get('root')!
    if (field === 'version') declared.verifiers[0]!.version = '2'
    else declared.verifiers[0]!.args = ['{input}', '{artifact}']
    await writeFile(join(dir, 'task.json'), JSON.stringify(declared))
    expect((await loadDomain(dir, spawnProcess)).templates.get('root')!.digest).not.toBe(first.digest)
  })

  it('binds a source template to the exact initial bytes it loaded', async () => {
    const declared = declaration()
    const template = { ...declared.templates[0]!, workspace: { artifact: 'edited.txt', initial: 'seed.txt' } }
    const dir = await fixture({ ...declared, templates: [template] })
    const first = (await loadDomain(dir, spawnProcess)).templates.get('root')!
    expect(new TextDecoder().decode(first.initial!.bytes)).toBe('seed source')
    await writeFile(join(dir, 'seed.txt'), 'new starting bytes')
    expect((await loadDomain(dir, spawnProcess)).templates.get('root')!.digest).not.toBe(first.digest)
  })

  it('allows distinct protected sources and fixes an artifact template source before any task runs', async () => {
    const declared = declaration()
    const first = declared.templates[0]!
    const dir = await fixture({ ...declared, inputs: [...declared.inputs, { ref: 'other', from: 'fail.txt' }, { ref: 'unused', from: 'seed.txt' }],
      templates: [first, { ...first, id: 'other', input: { name: 'other.txt', source: { kind: 'protected', ref: 'other' } } },
        { ...first, id: 'dependent', input: { name: 'extracted.txt', source: { kind: 'artifact', template: 'root' } } },
      ],
    })
    const domain = await loadDomain(dir, spawnProcess)
    expect([domain.inputs.map((input) => input.ref), domain.templates.get('dependent')!.input.source]).toEqual([
      ['material', 'other', 'unused'], { kind: 'artifact', template: 'root' },
    ])
  })

  it('resolves only the exact admitted template identity', async () => {
    const domain = await loadDomain(await fixture(declaration()), spawnProcess)
    const root = domain.templates.get('root')!
    expect(templateOf(domain, { id: root.id, digest: root.digest })).toBe(root)
    for (const reference of [{ id: 'absent', digest: root.digest }, { id: root.id, digest: '0'.repeat(64) },
    ])
      expect(refusalOf(() => templateOf(domain, reference))).toMatchObject({ code: 'malformed-declaration' })
  })

  it('canonicalizes a template declaration without depending on JSON key order or spacing', async () => {
    const declared = declaration()
    const dir = await fixture(declared)
    const first = (await loadDomain(dir, spawnProcess)).templates.get('root')!
    declared.templates[0] = Object.fromEntries(Object.entries(declared.templates[0]!).reverse(),
    ) as (typeof declared.templates)[0]
    await writeFile(join(dir, 'task.json'), JSON.stringify(declared, null, 2))
    expect((await loadDomain(dir, spawnProcess)).templates.get('root')!.digest).toBe(first.digest)
  })

  it.each(['template', 'input', 'source', 'workspace', 'criterion', 'verifier', 'sample'] as const)
    ('refuses an undeclared %s member', async (boundary) => {
      const declared = declaration()
      const template = declared.templates[0]!
      const records = { template, input: template.input, source: template.input.source, workspace: template.workspace,
        criterion: template.criterion, verifier: declared.verifiers[0]!, sample: declared.verifiers[0]!.selftest[0]!,
      }
      Object.assign(records[boundary], { invented: true })
      const dir = await fixture(declared)
      expect(await asyncRefusalOf(() => loadDomain(dir, spawnProcess)))
        .toMatchObject({ code: 'malformed-declaration', detail: expect.stringContaining('invented'),
      })
    },
  )

  it.each([
    ['unknown root', { rootTemplate: 'absent' }],
    ['unknown protected source', { templates: [{ ...declaration().templates[0]!, input: { name: 'in.txt', source: { kind: 'protected', ref: 'absent' } } },
        ],
      },
    ],
    ['unknown artifact source', { templates: [...declaration().templates, { ...declaration().templates[0]!, id: 'child', input: { name: 'in.txt', source: { kind: 'artifact', template: 'absent' } },
          },
        ],
      },
    ],
    ['artifact root', { templates: [{ ...declaration().templates[0]!, input: { name: 'in.txt', source: { kind: 'artifact', template: 'root' } } },
        ],
      },
    ],
    ['template cycle', { templates: [...declaration().templates,
      { ...declaration().templates[0]!, id: 'a', input: { name: 'a.txt', source: { kind: 'artifact', template: 'b' } },
          },
      { ...declaration().templates[0]!, id: 'b', input: { name: 'b.txt', source: { kind: 'artifact', template: 'a' } },
          },
        ],
      },
    ],
    ['duplicate template', { templates: [declaration().templates[0]!, declaration().templates[0]!] }],
    ['duplicate protected source', { inputs: [declaration().inputs[0]!, declaration().inputs[0]!] }],
    ['idle metric', { metric: {} }],
  ])('refuses %s before publishing a domain', async (_name, changed) => {
    const dir = await fixture({ ...declaration(), ...changed })
    expect(await asyncRefusalOf(() => loadDomain(dir, spawnProcess))).toMatchObject({ code: 'malformed-declaration' })
  })

  it.each(['artifact'] as const)('refuses a template %s outside its Run workspace', async (field) => {
    const declared = declaration()
    const template = declared.templates[0]!
    template.workspace[field] = '../outside.txt'
    expect(await asyncRefusalOf(() => fixture(declared).then((dir) => loadDomain(dir, spawnProcess))))
      .toMatchObject({ code: 'malformed-declaration', detail: expect.stringContaining('outside'),
    })
  })

  it('refuses an input that resolves outside the domain, by name', async () => {
    const dir = await fixture({ ...declaration(), inputs: [{ ref: 'material', from: '../outside.txt' }] })
    expect((await asyncRefusalOf(() => loadDomain(dir, spawnProcess))).detail).toContain('outside')
  })

  it.each([
    { artifact: 'report.txt', initial: 'pass.txt', initialContent: 'ambiguous' },
    { artifact: 'in/source.txt' },
    { submission: 'binary', file: 'program.mjs', artifact: 'report.txt' },
  ])('refuses an inconsistent $submission workspace', async (workspace) => {
    const dir = await fixture({ ...declaration(), templates: [{ ...declaration().templates[0]!, workspace }] })
    expect(await asyncRefusalOf(() => loadDomain(dir, spawnProcess))).toMatchObject({ code: 'malformed-declaration' })
  })

  it('refuses a criterion naming a verifier the domain does not hold', async () => {
    const template = declaration().templates[0]!
    const dir = await fixture({ ...declaration(), templates: [{ ...template, criterion: { ...template.criterion, verifier: 'absent' } }],
    })
    expect((await asyncRefusalOf(() => loadDomain(dir, spawnProcess))).detail).toContain('absent')
  })

  it('refuses a sample whose artifact is not the file its command reads', async () => {
    const declared = declaration()
    declared.verifiers[0]!.selftest[0]!.argv[0] = 'fail.txt'
    const dir = await fixture(declared)
    expect((await asyncRefusalOf(() => loadDomain(dir, spawnProcess))).detail).toContain('correct')
  })

  it('refuses a command template naming a placeholder this version cannot fill', async () => {
    const declared = declaration()
    declared.verifiers[0]!.args = ['{artifact}', '{artifactt}']
    const dir = await fixture(declared)
    expect((await asyncRefusalOf(() => loadDomain(dir, spawnProcess))).detail).toContain('{artifactt}')
  })

  it.each(['letters', 'extract-letters'])('runs the declared %s samples through their independent real verifier', async (ref) => {
    const domain = await loadDomain(REAL, spawnProcess)
    const verifier = domain.verifiers.find((entry) => entry.ref === ref)!
    expect(await runVerifierSelftest(verifier)).toMatchObject({ ran: ref === 'letters' ? 2 : 5, failures: [] })
    expect(domain.templates.size).toBe(3)
  },
  )

  it('counts only ASCII extractions with a decimal report and zero or one trailing LF', async () => {
    const domain = await loadDomain(REAL, spawnProcess)
    expect(await runVerifierSelftest(domain.templates.get('count-letters')!.verifier!)).toMatchObject({ ran: 8, failures: [],
    })
  })
})

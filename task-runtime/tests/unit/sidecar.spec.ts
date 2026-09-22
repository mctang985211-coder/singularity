import { afterEach, describe, expect, test } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skillContractDigest } from '@dangosys/dsh-singularity-task'
import {
  capabilityToolQuery,
  executionProviders,
  loadSkillSidecar,
  registryRevision,
  skillValidationContext,
  validateSkillProvider,
} from '../../src/sidecar.ts'
import type {
  AcceptedSkillProviderVerdict,
  RejectedProviderVerdict,
  SkillValidationContext,
} from '../../src/sidecar.ts'

const FIXTURE_SKILLS = fileURLToPath(new URL('../fixtures/skills/', import.meta.url))

/** The BB capability rows the fixtures are built against — the real table, narrowed to these skills. */
const CAPABILITIES = {
  'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'] },
  'verify-ball-functional': { skills: ['verify'], tools: ['filesystem', 'bash', 'jobs'], preset: 'bb-verify', mcpServers: ['bbdev'] },
  'integrate-model': { skills: ['workload-tests'] },
}

const VERIFIER_REFS = ['command', 'composite', 'review']
const CONTEXT: SkillValidationContext = skillValidationContext(CAPABILITIES, VERIFIER_REFS)

const tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A private copy of one fixture skill, so a test can mutate the bytes it reads. */
async function fixture(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'skill-sidecar-'))
  tempRoots.push(root)
  const directory = join(root, name)
  await cp(join(FIXTURE_SKILLS, name), directory, { recursive: true })
  return directory
}

function codes(verdict: { defects: readonly { code: string }[] }): string[] {
  return verdict.defects.map(defect => defect.code)
}

function details(verdict: { defects: readonly { code: string; detail: string }[] }, code: string): string[] {
  return verdict.defects.filter(defect => defect.code === code).map(defect => defect.detail)
}

function accepted(verdict: Awaited<ReturnType<typeof validateSkillProvider>>): AcceptedSkillProviderVerdict {
  if (!verdict.valid) {
    throw new Error(`expected an accepted provider, got: ${verdict.defects.map(d => `${d.code}: ${d.detail}`).join('; ')}`)
  }
  return verdict
}

function rejected(verdict: Awaited<ReturnType<typeof validateSkillProvider>>): RejectedProviderVerdict {
  if (verdict.valid) throw new Error(`expected a refused provider, got role ${verdict.role}`)
  return verdict
}

/** Read a sidecar file, change one field, write it back — a tampered declaration. */
async function patchSidecar(directory: string, patch: (sidecar: Record<string, unknown>) => void): Promise<void> {
  const file = join(directory, 'SKILL.contract.json')
  const sidecar = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  patch(sidecar)
  await writeFile(file, JSON.stringify(sidecar, null, 2))
}

describe('loadSkillSidecar', () => {
  test('a knowledge fixture loads with no defects and its declared identity matches the files on disk', async () => {
    const directory = await fixture('ball-align')
    const loaded = await loadSkillSidecar(directory)
    expect(loaded.defects).toEqual([])
    expect(loaded.sidecar?.type).toBe('knowledge')
    expect(loaded.content?.resources.map(resource => resource.path))
      .toEqual(['references/contract-checklist.md', 'references/illegal-input-table.md'])
    // The digest is the declared one, read from the real file bytes — not a re-derivation of the JSON.
    expect(loaded.content).toEqual(loaded.sidecar?.content)
    expect(loaded.content?.skillMdSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('an execution fixture loads with no defects', async () => {
    const directory = await fixture('verify')
    const loaded = await loadSkillSidecar(directory)
    expect(loaded.defects).toEqual([])
    expect(loaded.sidecar?.type).toBe('execution')
    expect(loaded.content?.resources).toEqual([{
      path: 'scripts/run_bemu.sh',
      sha256: '0aec21463951dcdd02a076b6d0fed94118b03d1df4ef90b34d9aa0ee6fac4503',
    }])
  })

  test('a skill without a sidecar is a plain guidance load, not a defect', async () => {
    const directory = await fixture('ball-align')
    await rm(join(directory, 'SKILL.contract.json'))
    const loaded = await loadSkillSidecar(directory)
    expect(loaded.defects).toEqual([])
    expect(loaded.sidecar).toBeUndefined()
    expect(loaded.content?.skillMdSha256).toBe('412c58c716906d67668497b5ffe5407c4f9861bd807c4b96be6e43d0625df164')
  })

  test('malformed JSON is refused by file name', async () => {
    const directory = await fixture('ball-align')
    await writeFile(join(directory, 'SKILL.contract.json'), '{"contractVersion": 1,')
    const loaded = await loadSkillSidecar(directory)
    expect(codes(loaded)).toEqual(['sidecar-unreadable'])
    expect(details(loaded, 'sidecar-unreadable')[0]).toContain('SKILL.contract.json')
  })

  test('an unknown contract version is refused by number', async () => {
    const directory = await fixture('ball-align')
    await patchSidecar(directory, sidecar => { sidecar.contractVersion = 2 })
    const loaded = await loadSkillSidecar(directory)
    expect(codes(loaded)).toEqual(['sidecar-unknown-version'])
    expect(details(loaded, 'sidecar-unknown-version')[0]).toContain('2')
  })

  test('a field outside the closed set is refused by name', async () => {
    const directory = await fixture('verify')
    await patchSidecar(directory, sidecar => { sidecar.effort = 'high' })
    const loaded = await loadSkillSidecar(directory)
    expect(codes(loaded)).toEqual(['sidecar-unknown-field'])
    expect(details(loaded, 'sidecar-unknown-field')[0]).toContain('"effort"')
  })

  test('a SKILL.md that changed by one byte no longer matches the declared identity', async () => {
    const directory = await fixture('workload-tests')
    const file = join(directory, 'SKILL.md')
    await writeFile(file, (await readFile(file, 'utf8')).replace('Manifest rules', 'Manifest rule '))
    const loaded = await loadSkillSidecar(directory)
    expect(codes(loaded)).toEqual(['content-mismatch'])
    expect(details(loaded, 'content-mismatch')[0]).toContain('SKILL.md')
    expect(details(loaded, 'content-mismatch')[0]).toContain('5653a0e3563dab23a52eb161b125a7d52da85d5f5138c318826cd31c1be56ef1')
  })

  test('a referenced resource that changed by one byte no longer matches its identity', async () => {
    const directory = await fixture('ball-align')
    const file = join(directory, 'references', 'illegal-input-table.md')
    await writeFile(file, `${await readFile(file, 'utf8')}\n`)
    const loaded = await loadSkillSidecar(directory)
    expect(codes(loaded)).toEqual(['content-mismatch'])
    expect(details(loaded, 'content-mismatch')[0]).toContain('references/illegal-input-table.md')
  })

  test('a declared resource that disappeared is refused by path', async () => {
    const directory = await fixture('ball-align')
    await rm(join(directory, 'references', 'contract-checklist.md'))
    const loaded = await loadSkillSidecar(directory)
    expect(codes(loaded)).toEqual(['content-mismatch'])
    expect(details(loaded, 'content-mismatch')[0]).toContain('references/contract-checklist.md')
    expect(details(loaded, 'content-mismatch')[0]).toContain('missing')
  })

  test('a file present but not declared is refused rather than silently uncovered', async () => {
    const directory = await fixture('ball-align')
    await writeFile(join(directory, 'references', 'extra.md'), 'not declared anywhere\n')
    const loaded = await loadSkillSidecar(directory)
    expect(codes(loaded)).toEqual(['content-unsupported'])
    expect(details(loaded, 'content-unsupported')[0]).toContain('references/extra.md')
    expect(details(loaded, 'content-unsupported')[0]).toContain('not covered by the declared identity')
  })

  test('a file at the skill root that the declared shape does not support is refused', async () => {
    const directory = await fixture('workload-tests')
    await writeFile(join(directory, 'README.md'), 'extra\n')
    const loaded = await loadSkillSidecar(directory)
    expect(codes(loaded)).toEqual(['content-unsupported'])
    expect(details(loaded, 'content-unsupported')[0]).toContain('README.md')
  })

  test('a symbolic link is refused by name, never followed', async () => {
    const directory = await fixture('ball-align')
    const link = join(directory, 'references', 'illegal-input-table.md')
    await rm(link)
    await symlink(join(directory, 'SKILL.md'), link)
    const loaded = await loadSkillSidecar(directory)
    expect(codes(loaded)).toContain('content-unsupported')
    expect(details(loaded, 'content-unsupported').join('\n')).toContain('references/illegal-input-table.md')
    expect(details(loaded, 'content-unsupported').join('\n')).toContain('is a symbolic link')
  })

  test('a directory nested deeper than the declared one-level shape is refused', async () => {
    const directory = await fixture('ball-align')
    await mkdir(join(directory, 'references', 'deep'))
    await writeFile(join(directory, 'references', 'deep', 'a.md'), 'nested\n')
    const loaded = await loadSkillSidecar(directory)
    expect(codes(loaded)).toEqual(['content-unsupported'])
    expect(details(loaded, 'content-unsupported')[0]).toContain('references/deep')
    expect(details(loaded, 'content-unsupported')[0]).toContain('nested')
  })

  test('a binary resource is refused by path instead of being hashed as if it were readable', async () => {
    const directory = await fixture('verify')
    await writeFile(join(directory, 'scripts', 'run_bemu.sh'), Buffer.from([0x00, 0x01, 0x02, 0xff]))
    const loaded = await loadSkillSidecar(directory)
    expect(codes(loaded)).toEqual(['content-unsupported'])
    expect(details(loaded, 'content-unsupported')[0]).toContain('scripts/run_bemu.sh')
    expect(details(loaded, 'content-unsupported')[0]).toContain('UTF-8')
  })

  test('a missing SKILL.md is refused by name', async () => {
    const directory = await fixture('workload-tests')
    await rm(join(directory, 'SKILL.md'))
    const loaded = await loadSkillSidecar(directory)
    expect(codes(loaded)).toEqual(['skill-missing'])
    expect(details(loaded, 'skill-missing')[0]).toContain('SKILL.md')
  })

  test('a directory that does not exist is refused, with no side effects', async () => {
    const loaded = await loadSkillSidecar(join(tmpdir(), 'skill-sidecar-does-not-exist'))
    expect(codes(loaded)).toEqual(['skill-missing'])
  })
})

describe('validateSkillProvider', () => {
  test('the execution fixture is a valid provider for its declared capability', async () => {
    const directory = await fixture('verify')
    const verdict = accepted(await validateSkillProvider({ name: 'verify', directory }, CONTEXT))
    expect(verdict.role).toBe('execution-provider')
    if (verdict.role !== 'execution-provider') throw new Error('unreachable')
    expect(verdict.capabilities).toEqual(['verify-ball-functional'])
    expect(verdict.verifierRef).toBe('command')
    expect(verdict.requiredTools).toContain('mcp__bbdev__bbdev_bemu_sim')
    expect(verdict.content.skillMdSha256).toMatch(/^[0-9a-f]{64}$/)
    // The declaration's own facts travel with the verdict, so the caller that
    // renders a worker summary does not have to re-read the file.
    expect(verdict.precondition).toContain('bbdev')
    expect(verdict.inputs.map(port => port.name)).toEqual(['ball', 'chip', 'platform'])
    expect(verdict.outputs.map(port => port.name)).toEqual(['bemu-log', 'rtl-report'])
    expect(verdict.contractDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(verdict.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(verdict.contentDigest).not.toBe(verdict.contractDigest)
  })

  test('a knowledge fixture is loadable and validated, and is not an execution provider', async () => {
    const directory = await fixture('ball-align')
    const verdict = accepted(await validateSkillProvider({ name: 'ball-align', directory }, CONTEXT))
    expect(verdict.role).toBe('knowledge')
    expect(verdict).not.toHaveProperty('capabilities')
    if (verdict.role !== 'knowledge') throw new Error('unreachable')
    expect(verdict.source).toContain('ball-dev-guide')
    expect(verdict.scope).toContain('Ball-level')
    // The content check is carried as the reference it is; nothing here runs it.
    expect(verdict.contentCheck).toEqual({
      kind: 'command',
      command: "grep -q 'Illegal-input table' references/illegal-input-table.md",
    })
    expect(verdict.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(executionProviders([verdict])).toEqual([])
  })

  test('a skill without a sidecar is guidance: no execution provider, no defect', async () => {
    const directory = await fixture('workload-tests')
    await rm(join(directory, 'SKILL.contract.json'))
    const verdict = accepted(await validateSkillProvider({ name: 'workload-tests', directory }, CONTEXT))
    expect(verdict.role).toBe('guidance')
    if (verdict.role !== 'guidance') throw new Error('unreachable')
    expect(verdict.uncovered).toEqual([])
    expect(verdict.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(executionProviders([verdict])).toEqual([])
  })

  test('guidance names what its identity does not cover', async () => {
    const directory = await fixture('ball-align')
    await rm(join(directory, 'SKILL.contract.json'))
    await writeFile(join(directory, 'README.md'), 'extra\n')
    await mkdir(join(directory, 'agents'))
    const verdict = accepted(await validateSkillProvider({ name: 'ball-align', directory }, CONTEXT))
    expect(verdict.role).toBe('guidance')
    if (verdict.role !== 'guidance') throw new Error('unreachable')
    expect(verdict.uncovered).toEqual(['README.md', 'agents/'])
  })

  test('an undiscovered skill is refused by name', async () => {
    const verdict = rejected(await validateSkillProvider({ name: 'waveform' }, CONTEXT))
    expect(codes(verdict)).toEqual(['skill-missing'])
    expect(details(verdict, 'skill-missing')[0]).toContain('waveform')
  })

  test('a directory named after another skill is refused', async () => {
    const directory = await fixture('ball-align')
    const verdict = rejected(await validateSkillProvider({ name: 'something-else', directory }, CONTEXT))
    // Two mismatches are reported because there are two: the directory is named
    // after another skill, and the file inside it declares another name than the
    // capability grants. The second is the spawn's own rule, in its own words.
    expect(codes(verdict)).toEqual(['skill-name-mismatch', 'skill-name-mismatch'])
    expect(details(verdict, 'skill-name-mismatch')[0]).toContain('ball-align')
    expect(details(verdict, 'skill-name-mismatch')[1]).toContain('declares name "ball-align" but the capability grants "something-else"')
  })

  test('a symbolic link standing in for the skill directory is refused', async () => {
    const directory = await fixture('ball-align')
    const root = await mkdtemp(join(tmpdir(), 'skill-sidecar-'))
    tempRoots.push(root)
    const link = join(root, 'ball-align')
    await symlink(directory, link)
    const verdict = rejected(await validateSkillProvider({ name: 'ball-align', directory: link }, CONTEXT))
    expect(codes(verdict)).toEqual(['content-unsupported'])
    expect(details(verdict, 'content-unsupported')[0]).toContain('is a symbolic link')
  })

  test('an execution sidecar whose verifier is not registered is not a valid provider', async () => {
    const directory = await fixture('verify')
    const withoutCommand = skillValidationContext(CAPABILITIES, ['review', 'composite'])
    const verdict = rejected(await validateSkillProvider({ name: 'verify', directory }, withoutCommand))
    expect(codes(verdict)).toEqual(['verifier-unknown'])
    expect(details(verdict, 'verifier-unknown')[0]).toContain('"command"')
    expect(details(verdict, 'verifier-unknown')[0]).toContain('composite, review')
  })

  test('required tools outside the declared capabilities are refused, naming each one', async () => {
    const directory = await fixture('verify')
    await patchSidecar(directory, sidecar => {
      sidecar.requiredTools = ['read', 'web_search', 'subagent']
    })
    const verdict = rejected(await validateSkillProvider({ name: 'verify', directory }, CONTEXT))
    expect(codes(verdict)).toEqual(['tool-not-covered'])
    expect(details(verdict, 'tool-not-covered')[0]).toContain('"subagent"')
    expect(details(verdict, 'tool-not-covered')[0]).toContain('"web_search"')
    expect(details(verdict, 'tool-not-covered')[0]).toContain('verify-ball-functional')
  })

  test('a capability the table does not know is refused by name', async () => {
    const directory = await fixture('verify')
    await patchSidecar(directory, sidecar => {
      sidecar.capabilities = ['no-such-capability']
      sidecar.requiredTools = []
    })
    const verdict = rejected(await validateSkillProvider({ name: 'verify', directory }, CONTEXT))
    expect(codes(verdict)).toEqual(['capability-unknown'])
    expect(details(verdict, 'capability-unknown')[0]).toContain('no-such-capability')
  })

  test('a capability row whose labels do not expand is refused with the config reason', async () => {
    const directory = await fixture('verify')
    const broken = skillValidationContext({
      'verify-ball-functional': { skills: ['verify'], tools: ['filesytem'] },
    }, VERIFIER_REFS)
    const verdict = rejected(await validateSkillProvider({ name: 'verify', directory }, broken))
    expect(codes(verdict)).toEqual(['capability-unknown'])
    expect(details(verdict, 'capability-unknown')[0]).toContain('unknown tool label "filesytem"')
  })

  test('a capability that does not grant the tools the sidecar needs is refused', async () => {
    const directory = await fixture('verify')
    const noTools = skillValidationContext({ 'verify-ball-functional': { skills: ['verify'] } }, VERIFIER_REFS)
    const verdict = rejected(await validateSkillProvider({ name: 'verify', directory }, noTools))
    expect(details(verdict, 'tool-not-covered')[0]).toContain('"read"')
    expect(details(verdict, 'tool-not-covered')[0]).toContain('"mcp__bbdev__bbdev_bemu_sim"')
  })

  test('a sidecar the caller already loaded must still describe the directory it is validated against', async () => {
    const directory = await fixture('verify')
    const loaded = await loadSkillSidecar(directory)
    const matching = accepted(await validateSkillProvider(
      { name: 'verify', directory, sidecar: loaded.sidecar },
      CONTEXT,
    ))
    expect(matching.role).toBe('execution-provider')

    const other = await fixture('ball-align')
    const knowledge = await loadSkillSidecar(other)
    const mismatched = rejected(await validateSkillProvider(
      { name: 'verify', directory, sidecar: knowledge.sidecar },
      CONTEXT,
    ))
    expect(codes(mismatched)).toEqual(['sidecar-mismatch'])
    expect(details(mismatched, 'sidecar-mismatch')[0]).toContain('SKILL.contract.json')
  })

  test('tampered content is refused through the validator, not only through the loader', async () => {
    const directory = await fixture('ball-align')
    await writeFile(join(directory, 'references', 'illegal-input-table.md'), 'rewritten\n')
    const verdict = rejected(await validateSkillProvider({ name: 'ball-align', directory }, CONTEXT))
    expect(codes(verdict)).toEqual(['content-mismatch'])
    expect(details(verdict, 'content-mismatch')[0]).toContain('references/illegal-input-table.md')
  })

  test('only execution verdicts are execution providers', async () => {
    const execution = accepted(await validateSkillProvider({ name: 'verify', directory: await fixture('verify') }, CONTEXT))
    const knowledge = accepted(await validateSkillProvider({ name: 'ball-align', directory: await fixture('ball-align') }, CONTEXT))
    const guidance = accepted(await validateSkillProvider({ name: 'ball-align', directory: await (async () => {
      const directory = await fixture('ball-align')
      await rm(join(directory, 'SKILL.contract.json'))
      return directory
    })() }, CONTEXT))
    const refused = rejected(await validateSkillProvider({ name: 'verify' }, CONTEXT))
    expect(executionProviders([execution, knowledge, guidance, refused])).toEqual([execution])
  })
})

describe('capabilityToolQuery', () => {
  test('a known capability reports its expanded names and mounted servers', () => {
    const query = capabilityToolQuery(CAPABILITIES)
    expect(query('verify-ball-functional')).toEqual({
      known: true,
      tools: ['read', 'write', 'edit', 'bash', 'job_output', 'job_list', 'job_kill'],
      mcpServers: ['bbdev'],
    })
  })

  test('an unknown capability and an unexpandable row are both reported as unknown with a reason', () => {
    const query = capabilityToolQuery(CAPABILITIES)
    const unknown = query('nope')
    expect(unknown.known).toBe(false)
    if (unknown.known) throw new Error('unreachable')
    expect(unknown.reason).toContain('nope')
    const broken = capabilityToolQuery({ broken: { tools: ['shel'] } })('broken')
    if (broken.known) throw new Error('unreachable')
    expect(broken.reason).toContain('unknown tool label "shel"')
  })
})

describe('registryRevision', () => {
  async function providerIdentities(): Promise<{ name: string; contractDigest: string | null }[]> {
    const ballAlign = await loadSkillSidecar(await fixture('ball-align'))
    const verify = await loadSkillSidecar(await fixture('verify'))
    return [
      { name: 'ball-align', contractDigest: ballAlign.sidecar === undefined ? null : skillContractDigest(ballAlign.sidecar) },
      { name: 'verify', contractDigest: verify.sidecar === undefined ? null : skillContractDigest(verify.sidecar) },
    ]
  }

  test('the same table and the same provider identities produce one revision, whatever order they arrive in', () => {
    const providers = [
      { name: 'verify', contractDigest: 'aa'.repeat(32) },
      { name: 'ball-align', contractDigest: 'bb'.repeat(32) },
    ]
    const reorderedRows = {
      'integrate-model': { skills: ['workload-tests'] },
      'verify-ball-functional': {
        skills: ['verify'],
        tools: ['filesystem', 'bash', 'jobs'],
        preset: 'bb-verify',
        mcpServers: ['bbdev'],
      },
      'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'] },
    }
    const revision = registryRevision(CAPABILITIES, providers)
    expect(revision).toMatch(/^[0-9a-f]{64}$/)
    expect(registryRevision(reorderedRows, [...providers].reverse())).toBe(revision)
    // declared order inside a row is not part of the grant
    expect(registryRevision({
      ...CAPABILITIES,
      'verify-ball-functional': { skills: ['verify'], tools: ['bash', 'jobs', 'filesystem'], preset: 'bb-verify', mcpServers: ['bbdev'] },
    }, providers)).toBe(revision)
  })

  test('declared defaults and their omission are the same entry', () => {
    expect(registryRevision({ row: { skills: ['a'], tools: [], mcpServers: [] } }, []))
      .toBe(registryRevision({ row: { skills: ['a'] } }, []))
  })

  test('a changed capability row moves the revision', () => {
    const providers = [{ name: 'verify', contractDigest: 'aa'.repeat(32) }]
    const base = registryRevision(CAPABILITIES, providers)
    expect(registryRevision({ ...CAPABILITIES, 'design-ball': { skills: ['ball-align'], tools: ['filesystem'] } }, providers)).not.toBe(base)
    expect(registryRevision({ ...CAPABILITIES, 'design-ball': { skills: ['ball-align', 'check'], tools: ['filesystem', 'bash'] } }, providers)).not.toBe(base)
    expect(registryRevision({ ...CAPABILITIES, 'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'], preset: 'standard' } }, providers)).not.toBe(base)
    expect(registryRevision({ ...CAPABILITIES, 'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'], permission: 'read-only' } }, providers)).not.toBe(base)
    expect(registryRevision({ ...CAPABILITIES, 'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'], mcpServers: ['bbdev'] } }, providers)).not.toBe(base)
    const { 'design-ball': removed, ...withoutRow } = CAPABILITIES
    expect(removed).toBeDefined()
    expect(registryRevision(withoutRow, providers)).not.toBe(base)
  })

  test('a changed provider sidecar, an added provider and a provider without a sidecar all move the revision', () => {
    const providers = [
      { name: 'ball-align', contractDigest: 'aa'.repeat(32) },
      { name: 'verify', contractDigest: 'bb'.repeat(32) },
    ]
    const base = registryRevision(CAPABILITIES, providers)
    expect(registryRevision(CAPABILITIES, [
      { name: 'ball-align', contractDigest: 'cc'.repeat(32) },
      { name: 'verify', contractDigest: 'bb'.repeat(32) },
    ])).not.toBe(base)
    expect(registryRevision(CAPABILITIES, [...providers, { name: 'check', contractDigest: null }])).not.toBe(base)
    expect(registryRevision(CAPABILITIES, [
      { name: 'ball-align', contractDigest: null },
      { name: 'verify', contractDigest: 'bb'.repeat(32) },
    ])).not.toBe(base)
    expect(registryRevision(CAPABILITIES, [
      { name: 'verify', contractDigest: 'bb'.repeat(32) },
    ])).not.toBe(base)
  })

  test('the fixture sidecars produce a revision from the real load path', async () => {
    const identities = await providerIdentities()
    const revision = registryRevision(CAPABILITIES, identities)
    const reloaded = await providerIdentities()
    expect(registryRevision(CAPABILITIES, reloaded)).toBe(revision)
    expect(identities.every(identity => identity.contractDigest !== null)).toBe(true)
  })
})

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CapabilityConfig } from '../../src/capability.ts'
import { precheckProviders, providerRefusals, skillSearchRoots } from '../../src/provider-precheck.ts'
import type { CapabilityProviderPrecheck, ProviderPrecheck } from '../../src/provider-precheck.ts'
import { executionProviders } from '../../src/sidecar.ts'
import type { ExecutionProviderVerdict, RejectedProviderVerdict, SkillProviderVerdict } from '../../src/sidecar.ts'

/**
 * The provider pre-check as a value: discovery from a worker's viewpoint, the
 * unified validator's verdict per skill, and the refusal lines a caller refuses
 * a whole batch with. Everything here runs against real fixture directories —
 * the same ones the loader spec uses — and asserts what the *result* says, never
 * that some private helper was called.
 */

const FIXTURE_SKILLS = fileURLToPath(new URL('../fixtures/skills/', import.meta.url))

/** The BB capability rows the fixtures are built against — the real table, narrowed to these skills. */
const TABLE: Readonly<Record<string, CapabilityConfig>> = {
  'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'] },
  'verify-ball-functional': { skills: ['verify'], tools: ['filesystem', 'bash', 'jobs'], preset: 'bb-verify', mcpServers: ['bbdev'] },
  'integrate-model': { skills: ['workload-tests'] },
}

const VERIFIER_REFS = ['command', 'composite', 'review']

let workspace: string
let home: string
let checkout: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'provider-precheck-unit-'))
  home = join(workspace, 'home')
  checkout = join(workspace, 'env')
  await mkdir(home, { recursive: true })
  await mkdir(checkout, { recursive: true })
  // The two roots outside the checkout are pinned inside this test's fixture, so
  // whatever the machine running the suite has under `$HOME/.agents/skills`
  // cannot decide a verdict here.
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(workspace, { recursive: true, force: true })
})

/** Install one fixture skill under a worker-visible root; `sidecar: false` leaves only its `SKILL.md`. */
async function install(
  name: string,
  options: { at?: 'checkout' | 'home' | 'user'; sidecar?: boolean } = {},
): Promise<string> {
  const root = options.at === 'home'
    ? join(home, 'skills')
    : options.at === 'user'
      ? join(home, '.agents', 'skills')
      : join(checkout, '.agents', 'skills')
  const directory = join(root, name)
  await cp(join(FIXTURE_SKILLS, name), directory, { recursive: true })
  if (options.sidecar === false) await rm(join(directory, 'SKILL.contract.json'))
  return directory
}

async function patchSidecar(directory: string, patch: (sidecar: Record<string, unknown>) => void): Promise<void> {
  const file = join(directory, 'SKILL.contract.json')
  const sidecar = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
  patch(sidecar)
  await writeFile(file, JSON.stringify(sidecar, null, 2))
}

/** SHA-256 of bytes, computed here so the implementation is never confirmed against itself. */
function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Rewrite one installed skill's `SKILL.md` frontmatter name, keeping the
 * directory internally consistent: a sidecar'd skill gets its declared
 * `SKILL.md` digest re-declared over the new bytes, so the *only* thing wrong
 * with the directory is the name it loads under.
 */
async function rename(directory: string, name: string): Promise<void> {
  const text = await readFile(join(directory, 'SKILL.md'), 'utf8')
  const rewritten = text.replace(/^name:.*$/m, `name: ${name}`)
  await writeFile(join(directory, 'SKILL.md'), rewritten)
  const sidecar = join(directory, 'SKILL.contract.json')
  const declared = await readFile(sidecar, 'utf8').catch(() => undefined)
  if (declared === undefined) return
  const parsed = JSON.parse(declared) as { content: { skillMdSha256: string } }
  parsed.content.skillMdSha256 = sha256Of(rewritten)
  await writeFile(sidecar, JSON.stringify(parsed, null, 2))
}

interface PrecheckOptions {
  capabilities?: readonly string[]
  table?: Readonly<Record<string, CapabilityConfig>>
  cwd?: string | undefined
  extraRoots?: readonly string[]
  verifierRefs?: readonly string[] | undefined
}

async function precheck(options: PrecheckOptions = {}): Promise<ProviderPrecheck> {
  const cwd = 'cwd' in options ? options.cwd : checkout
  const verifierRefs = 'verifierRefs' in options ? options.verifierRefs : VERIFIER_REFS
  return precheckProviders({
    capabilities: options.capabilities ?? ['design-ball'],
    table: options.table ?? TABLE,
    view: {
      ...(cwd === undefined ? {} : { cwd }),
      ...(options.extraRoots === undefined ? {} : { extraRoots: [...options.extraRoots] }),
    },
    ...(verifierRefs === undefined ? {} : { verifierRefs }),
  })
}

/** One skill's verdict inside one capability row; a name the pre-check never reached is a test failure. */
function verdict(report: ProviderPrecheck, capability: string, name: string): SkillProviderVerdict {
  const row: CapabilityProviderPrecheck | undefined = report.capabilities.find(item => item.capability === capability)
  if (row === undefined) throw new Error(`the pre-check holds no row for capability "${capability}"`)
  const found = row.skills.find(item => item.name === name)
  if (found === undefined) throw new Error(`row "${capability}" holds no verdict for skill "${name}"`)
  return found
}

function rejected(verdictValue: SkillProviderVerdict): RejectedProviderVerdict {
  if (verdictValue.valid) throw new Error(`expected a refusal, got role ${verdictValue.role}`)
  return verdictValue
}

function acceptedExecution(verdictValue: SkillProviderVerdict): ExecutionProviderVerdict {
  if (!verdictValue.valid || verdictValue.role !== 'execution-provider') {
    throw new Error(`expected an execution provider, got ${verdictValue.valid ? verdictValue.role : 'invalid'}`)
  }
  return verdictValue
}

function codes(verdictValue: RejectedProviderVerdict): string[] {
  return verdictValue.defects.map(defect => defect.code)
}

describe('precheckProviders', () => {
  test('an execution provider found from the worker\'s own checkout is accepted, with the facts a run records', async () => {
    const directory = await install('verify')
    const report = await precheck({ capabilities: ['verify-ball-functional'] })

    expect(providerRefusals(report)).toEqual([])
    expect(report.verifierRefs).toEqual(VERIFIER_REFS)
    expect(report.revision).toMatch(/^[0-9a-f]{64}$/)
    const verdictValue = acceptedExecution(verdict(report, 'verify-ball-functional', 'verify'))
    expect(verdictValue.directory).toBe(directory)
    expect(verdictValue.verifierRef).toBe('command')
    expect(verdictValue.capabilities).toEqual(['verify-ball-functional'])
    expect(verdictValue.content.skillMdSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(verdictValue.contentDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(verdictValue.contractDigest).toMatch(/^[0-9a-f]{64}$/)
    // The roots the discovery actually walked are reported, in order, starting
    // at the checkout — the directory a spawned worker's cwd resolves to.
    expect(report.roots[0]).toBe(join(checkout, '.agents', 'skills'))
    expect(report.roots).toContain(join(home, 'skills'))
    expect(report.roots).toContain(join(home, '.agents', 'skills'))
  })

  test('the deployment skill home and the user root are searched as well', async () => {
    await install('verify', { at: 'home' })
    expect(providerRefusals(await precheck({ capabilities: ['verify-ball-functional'] }))).toEqual([])

    await install('workload-tests', { at: 'user' })
    expect(providerRefusals(await precheck({ capabilities: ['integrate-model'] }))).toEqual([])
  })

  test('an undiscoverable skill is refused by capability, skill and every root searched', async () => {
    const report = await precheck({
      capabilities: ['design-ball'],
      table: { 'design-ball': { skills: ['missing-provider-skill'] } },
    })

    const verdictValue = rejected(verdict(report, 'design-ball', 'missing-provider-skill'))
    expect(codes(verdictValue)).toEqual(['skill-missing'])
    const [line] = providerRefusals(report)
    expect(line).toContain('capability "design-ball"')
    expect(line).toContain('skill "missing-provider-skill"')
    expect(line).toContain(join(checkout, '.agents', 'skills'))
    expect(line).toContain(join(home, 'skills'))
    expect(line).toContain(join(home, '.agents', 'skills'))
  })

  test('an execution sidecar whose verifier is not registered is refused, with the vocabulary named', async () => {
    await install('verify')
    const report = await precheck({ capabilities: ['verify-ball-functional'], verifierRefs: ['composite', 'review'] })

    const verdictValue = rejected(verdict(report, 'verify-ball-functional', 'verify'))
    expect(codes(verdictValue)).toEqual(['verifier-unknown'])
    expect(verdictValue.defects[0]!.detail).toContain('"command"')
    expect(verdictValue.defects[0]!.detail).toContain('composite, review')
  })

  test('required tools the declared capabilities do not grant are refused, naming each one', async () => {
    await install('verify')
    const report = await precheck({
      capabilities: ['verify-ball-functional'],
      table: { 'verify-ball-functional': { skills: ['verify'], preset: 'bb-verify' } },
    })

    const verdictValue = rejected(verdict(report, 'verify-ball-functional', 'verify'))
    expect(codes(verdictValue)).toEqual(['tool-not-covered'])
    expect(verdictValue.defects[0]!.detail).toContain('"mcp__bbdev__bbdev_bemu_sim"')
    expect(verdictValue.defects[0]!.detail).toContain('"bash"')
    expect(verdictValue.defects[0]!.detail).toContain('verify-ball-functional')
  })

  test('content that changed by one byte no longer matches the declared identity', async () => {
    const directory = await install('workload-tests')
    await writeFile(join(directory, 'references', 'regression-manifest.md'), 'rewritten\n')
    const report = await precheck({ capabilities: ['integrate-model'] })

    const verdictValue = rejected(verdict(report, 'integrate-model', 'workload-tests'))
    expect(codes(verdictValue)).toEqual(['content-mismatch'])
    expect(verdictValue.defects[0]!.detail).toContain('references/regression-manifest.md')
  })

  test('a resource whose shape the contract does not support is refused by path', async () => {
    const directory = await install('verify')
    const resource = join(directory, 'scripts', 'run_bemu.sh')
    await rm(resource)
    await symlink(join(directory, 'SKILL.md'), resource)
    const report = await precheck({ capabilities: ['verify-ball-functional'] })

    const verdictValue = rejected(verdict(report, 'verify-ball-functional', 'verify'))
    expect(codes(verdictValue)).toEqual(['content-unsupported'])
    expect(verdictValue.defects[0]!.detail).toContain('scripts/run_bemu.sh')
    expect(verdictValue.defects[0]!.detail).toContain('symbolic link')
  })

  test('a knowledge skill is loadable and is never an execution provider', async () => {
    await install('ball-align')
    const report = await precheck({ capabilities: ['design-ball'] })

    expect(providerRefusals(report)).toEqual([])
    const verdictValue = verdict(report, 'design-ball', 'ball-align')
    expect(verdictValue.valid && verdictValue.role).toBe('knowledge')
    // The one entry that may close an execution gap stays empty for it, however
    // loadable it is.
    expect(executionProviders([verdictValue])).toEqual([])
  })

  test('a skill without a sidecar is guidance: accepted, with what its identity does not cover named', async () => {
    const directory = await install('ball-align', { sidecar: false })
    await writeFile(join(directory, 'README.md'), 'extra\n')
    const report = await precheck({ capabilities: ['design-ball'] })

    expect(providerRefusals(report)).toEqual([])
    const verdictValue = verdict(report, 'design-ball', 'ball-align')
    expect(verdictValue.valid).toBe(true)
    if (!verdictValue.valid || verdictValue.role !== 'guidance') throw new Error('expected guidance')
    expect(verdictValue.uncovered).toEqual(['README.md'])
    expect(executionProviders([verdictValue])).toEqual([])
  })

  test('overlay roots are searched before the worker\'s own roots: the overlay skill is what is judged', async () => {
    // The checkout holds the full execution fixture; the overlay holds a
    // SKILL.md-only copy. Whichever the search reaches first is the verdict the
    // pre-check reports, and the grant registers the overlay first.
    await install('verify')
    const overlay = join(workspace, 'sandbox', 'skills')
    await mkdir(overlay, { recursive: true })
    await cp(join(FIXTURE_SKILLS, 'verify'), join(overlay, 'verify'), { recursive: true })
    await rm(join(overlay, 'verify', 'SKILL.contract.json'))

    const report = await precheck({ capabilities: ['verify-ball-functional'], extraRoots: [overlay] })

    expect(report.roots[0]).toBe(overlay)
    const verdictValue = verdict(report, 'verify-ball-functional', 'verify')
    expect(verdictValue.valid && verdictValue.role).toBe('guidance')
    expect(providerRefusals(report)).toEqual([])
  })

  test('an execution sidecar is refused when the verifier registry cannot be listed, while knowledge still loads', async () => {
    await install('verify')
    await install('ball-align')

    const withoutRegistry = await precheck({
      capabilities: ['verify-ball-functional', 'design-ball'],
      verifierRefs: undefined,
    })

    expect(withoutRegistry.verifierRefs).toBeUndefined()
    const execution = rejected(verdict(withoutRegistry, 'verify-ball-functional', 'verify'))
    expect(codes(execution)).toEqual(['verifier-unknown'])
    expect(execution.defects[0]!.detail).toContain('verifierIds() is unavailable')
    // A knowledge skill claims no verifier, so the same missing vocabulary loses
    // it nothing: it is judged by the validator like everywhere else.
    expect(verdict(withoutRegistry, 'design-ball', 'ball-align').valid).toBe(true)
    expect(providerRefusals(withoutRegistry)).toHaveLength(1)
  })

  test('the revision covers the table and the declared providers: identical inputs, one revision', async () => {
    await install('verify')
    await install('ball-align')
    const first = await precheck({ capabilities: ['verify-ball-functional', 'design-ball'] })
    const second = await precheck({ capabilities: ['verify-ball-functional', 'design-ball'] })
    expect(second.revision).toBe(first.revision)

    // A changed capability row moves it…
    const rowChanged = await precheck({
      capabilities: ['verify-ball-functional'],
      table: { ...TABLE, 'design-ball': { skills: ['ball-align'], tools: ['filesystem'] } },
    })
    expect(rowChanged.revision).not.toBe(first.revision)

    // …and so does a changed declaration in a provider's sidecar, while the
    // bytes a worker reads are untouched.
    const directory = join(checkout, '.agents', 'skills', 'ball-align')
    await patchSidecar(directory, sidecar => { sidecar.precondition = 'rewritten precondition' })
    const sidecarChanged = await precheck({ capabilities: ['verify-ball-functional', 'design-ball'] })
    expect(sidecarChanged.revision).not.toBe(first.revision)
  })

  test('every refusal is reported, not only the first', async () => {
    const report = await precheck({
      capabilities: ['design-ball', 'integrate-model'],
      table: {
        'design-ball': { skills: ['missing-provider-skill'] },
        'integrate-model': { skills: ['other-missing-skill'] },
      },
    })

    const lines = providerRefusals(report)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('capability "design-ball"')
    expect(lines[0]).toContain('missing-provider-skill')
    expect(lines[1]).toContain('capability "integrate-model"')
    expect(lines[1]).toContain('other-missing-skill')
  })

  test('without a checkout the project roots are not searched, and the refusal says so', async () => {
    // The skill exists, but only under a checkout the caller cannot name: the
    // deployment that cannot resolve one cannot promise the worker will find it,
    // so the batch is refused rather than admitted on a guess.
    await install('ball-align')
    const report = await precheck({ capabilities: ['design-ball'], cwd: undefined })

    const verdictValue = rejected(verdict(report, 'design-ball', 'ball-align'))
    expect(verdictValue.defects[0]!.code).toBe('skill-missing')
    expect(report.roots).not.toContain(join(checkout, '.agents', 'skills'))
    expect(report.roots).toContain(join(home, 'skills'))
    expect(report.roots).toContain(join(home, '.agents', 'skills'))
  })

  test('skillSearchRoots puts the overlay roots in front of the worker\'s own, in order', async () => {
    const roots = await skillSearchRoots({ cwd: checkout, extraRoots: ['/overlay/a', '/overlay/b'] })
    expect(roots.slice(0, 2)).toEqual(['/overlay/a', '/overlay/b'])
    expect(roots[2]).toBe(join(checkout, '.agents', 'skills'))
    expect(roots).toContain(join(home, 'skills'))
    expect(roots).toContain(join(home, '.agents', 'skills'))
  })
})

/**
 * The name a `SKILL.md` loads under (S1-C stage 3, the one fix carried in from
 * stage 2): the spawn registers a granted name from the bytes it reads, and
 * `readSkillFile` refuses a file whose frontmatter names something else. A
 * directory discovery found under this name but that declares another is
 * therefore known-unusable before the first write — the pre-check refuses it
 * with the same words the spawn would use, rather than admitting a batch whose
 * worker cannot load what its capability granted.
 */
describe('the frontmatter name a discovered SKILL.md declares', () => {
  test('a file that declares another skill is refused, in the words the spawn refuses it with', async () => {
    const directory = await install('ball-align', { sidecar: false })
    await writeFile(join(directory, 'SKILL.md'), '---\nname: not-ball-align\ndescription: some other skill entirely\n---\n\nbody\n')
    const report = await precheck({ capabilities: ['design-ball'] })

    const verdictValue = rejected(verdict(report, 'design-ball', 'ball-align'))
    expect(codes(verdictValue)).toEqual(['skill-name-mismatch'])
    expect(verdictValue.defects[0]!.detail).toContain(`skill file ${join(directory, 'SKILL.md')} declares name "not-ball-align" but the capability grants "ball-align"`)
    expect(providerRefusals(report)[0]).toContain('capability "design-ball"')
  })

  test('the same directory is admitted once the declared name is the granted name', async () => {
    const directory = await install('ball-align', { sidecar: false })
    await rename(directory, 'ball-align')

    expect(providerRefusals(await precheck({ capabilities: ['design-ball'] }))).toEqual([])
  })

  test('a sidecar-consistent directory that names another skill is still refused: content identity is not identity', async () => {
    // The declaration is re-pointed at the rewritten bytes, so every content
    // digest in the directory agrees with what stands there. What does not agree
    // is the name: a worker granted "ball-align" would register a body published
    // as "someone-else".
    const directory = await install('ball-align')
    await rename(directory, 'someone-else')
    const report = await precheck({ capabilities: ['design-ball'] })

    const verdictValue = rejected(verdict(report, 'design-ball', 'ball-align'))
    expect(codes(verdictValue)).toContain('skill-name-mismatch')
    expect(verdictValue.defects.map(defect => defect.code)).not.toContain('content-mismatch')
  })

  test('a SKILL.md whose frontmatter cannot be parsed is refused by name, not accepted as guidance', async () => {
    // No frontmatter at all: the registry could not publish this file either
    // (`readSkillFile` parses the same grammar), so admitting it would only move
    // the failure to the spawn.
    const directory = await install('ball-align', { sidecar: false })
    await writeFile(join(directory, 'SKILL.md'), '# Ball alignment\n\nno frontmatter here\n')
    const report = await precheck({ capabilities: ['design-ball'] })

    const verdictValue = rejected(verdict(report, 'design-ball', 'ball-align'))
    expect(codes(verdictValue)).toEqual(['skill-file-invalid'])
    expect(verdictValue.defects[0]!.detail).toContain('has no YAML frontmatter')
  })

  test('a directory named after the granted skill whose file declares it is unaffected by the new rule', async () => {
    // The positive half of every refusal above, over the execution fixture with
    // its sidecar: an ordinary installed skill still validates, still carries the
    // description its frontmatter declares, and still reports the identity a run
    // binds.
    const directory = await install('verify')
    const report = await precheck({ capabilities: ['verify-ball-functional'] })

    expect(providerRefusals(report)).toEqual([])
    const verdictValue = acceptedExecution(verdict(report, 'verify-ball-functional', 'verify'))
    expect(verdictValue.directory).toBe(directory)
    expect(verdictValue.description).toContain('Verify functional correctness of a Buckyball Ball')
  })
})

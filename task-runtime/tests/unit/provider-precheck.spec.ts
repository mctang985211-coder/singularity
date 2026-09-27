import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CapabilityConfig } from '../../src/capability.ts'
import { precheckProviders, providerRefusals, skillSearchRoots } from '../../src/provider-precheck.ts'
import type { CapabilityProviderPrecheck, EvolutionCommitLedger, ProviderPrecheck } from '../../src/provider-precheck.ts'
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
  commitLedger?: EvolutionCommitLedger | undefined
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
    ...(options.commitLedger === undefined ? {} : { commitLedger: options.commitLedger }),
  })
}

/** One capability row of one pre-check; a row the pre-check never reached is a test failure. */
function rowOf(report: ProviderPrecheck, capability: string): CapabilityProviderPrecheck {
  const row: CapabilityProviderPrecheck | undefined = report.capabilities.find(item => item.capability === capability)
  if (row === undefined) throw new Error(`the pre-check holds no row for capability "${capability}"`)
  return row
}

/** One skill's verdict inside one capability row; a name the pre-check never reached is a test failure. */
function verdict(report: ProviderPrecheck, capability: string, name: string): SkillProviderVerdict {
  const row = rowOf(report, capability)
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

/**
 * The evolution commit gate (K2-3): a production directory an apply/rollback left
 * a target in is not loaded against until a reconciliation settles it. The ledger
 * is read once per pre-check, softly — a deployment with no evolution service has
 * no commit in flight and no gate — and the gate answers for the provider whose
 * discovered directory holds a target and for nobody else. Since K3 the match is
 * the directory, not one file name: one intent covers a skill directory's fixed
 * file set together (`SKILL.md` plus its sidecar), so a target naming any file of
 * it refuses the whole directory — a mixed version is not admissible either.
 */
describe('the evolution commit gate', () => {
  /** A ledger that answers the two things the pre-check asks it: the files an open intent names, and the rows. */
  function ledger(
    openIntentTargets: () => Promise<readonly string[]>,
    openIntentCapabilities: () => Promise<readonly string[]> = async () => [],
  ): EvolutionCommitLedger {
    return { openIntentTargets, openIntentCapabilities }
  }

  test('a skill whose directory an open intent targets is refused, and only that skill is affected', async () => {
    const verifyDirectory = await install('verify')
    const ballDirectory = await install('ball-align')
    const read = vi.fn(async () => [join(verifyDirectory, 'SKILL.md')])
    const report = await precheck({
      capabilities: ['verify-ball-functional', 'design-ball'],
      commitLedger: ledger(read),
    })

    const refused = rejected(verdict(report, 'verify-ball-functional', 'verify'))
    expect(codes(refused)).toEqual(['commit-intent-open'])
    expect(refused.directory).toBe(verifyDirectory)
    const detail = refused.defects[0]!.detail
    // The refusal names the directory whose file set the intent covers, so an
    // operator looks at the skill, not at one path inside it.
    expect(detail).toContain(`a file of ${verifyDirectory}`)
    expect(detail).toContain('an apply or rollback')
    expect(detail).toContain('SKILL.contract.json')
    expect(detail).toContain('reconciliation')
    // The refusal line names the capability, the skill and the directory the way
    // every other refusal does.
    expect(providerRefusals(report)).toEqual([
      expect.stringContaining(`capability "verify-ball-functional" skill "verify" (found at ${verifyDirectory})`),
    ])
    expect(providerRefusals(report)[0]).toContain('commit-intent-open:')

    // The same pre-check over the unaffected row alone: the other provider
    // validates exactly as it does with no ledger in play at all, and the
    // report's other facts (the roots it searched) are intact.
    const withoutLedger = await precheck({ capabilities: ['design-ball'] })
    expect(providerRefusals(withoutLedger)).toEqual([])
    expect(verdict(report, 'design-ball', 'ball-align')).toEqual(verdict(withoutLedger, 'design-ball', 'ball-align'))
    expect(ballDirectory).toBe(join(checkout, '.agents', 'skills', 'ball-align'))
    expect(report.roots).toEqual(withoutLedger.roots)
    expect(read).toHaveBeenCalledTimes(1)
  })

  test('an intent against another directory blocks nothing here', async () => {
    // Only the directory the skill was *found* in decides: a target under a root
    // this worker never resolved (a same-name skill elsewhere, another skill's
    // files) leaves this provider exactly as it would be with no gate at all.
    await install('verify')
    const other = await install('ball-align')
    const report = await precheck({
      capabilities: ['verify-ball-functional'],
      commitLedger: ledger(async () => [
        join(home, 'skills', 'verify', 'SKILL.md'),
        join(other, 'SKILL.md'),
        join(other, 'SKILL.contract.json'),
      ]),
    })

    expect(providerRefusals(report)).toEqual([])
    expect(verdict(report, 'verify-ball-functional', 'verify').valid).toBe(true)
  })

  test('a target written with a redundant segment still resolves to the discovered directory', async () => {
    // The gate resolves a target to the directory holding it, so a path written
    // with a redundant separator or a `.` segment lands on the same directory as
    // the one discovery found.
    const directory = await install('verify')
    const report = await precheck({
      capabilities: ['verify-ball-functional'],
      commitLedger: ledger(async () => [join(directory, '.', 'SKILL.md')]),
    })

    expect(codes(rejected(verdict(report, 'verify-ball-functional', 'verify')))).toEqual(['commit-intent-open'])
  })

  test('an intent that names only the sidecar still refuses the skill: the gate matches the directory (K3)', async () => {
    // A K3 commit over an execution skill covers `SKILL.md` *and* the
    // `SKILL.contract.json` beside it, and the ledger may report either path.
    // A file-for-file match reads a sidecar target as "not this provider" and
    // admits a directory an open commit owns — a mixed version.
    const directory = await install('verify')
    const report = await precheck({
      capabilities: ['verify-ball-functional'],
      commitLedger: ledger(async () => [join(directory, 'SKILL.contract.json')]),
    })

    const refused = rejected(verdict(report, 'verify-ball-functional', 'verify'))
    expect(codes(refused)).toEqual(['commit-intent-open'])
    expect(refused.directory).toBe(directory)
    expect(refused.defects[0]!.detail).toContain(directory)
  })

  test('an intent naming both files of one directory refuses that skill once, for the directory they share', async () => {
    const directory = await install('verify')
    const report = await precheck({
      capabilities: ['verify-ball-functional'],
      commitLedger: ledger(async () => [join(directory, 'SKILL.md'), join(directory, 'SKILL.contract.json')]),
    })

    const refused = rejected(verdict(report, 'verify-ball-functional', 'verify'))
    expect(codes(refused)).toEqual(['commit-intent-open'])
    // One directory, one refusal: the two targets are one commit's fixed file
    // set, not two reasons to refuse the same provider twice.
    expect(refused.defects).toHaveLength(1)
  })

  test('any file path in the skill directory counts, whatever the file is called', async () => {
    // The gate does not enumerate the names a commit may write: a target is
    // resolved to the directory that holds it, so a path the ledger reports for
    // this skill cannot slip past a name list that has not learned it yet.
    const directory = await install('verify')
    const report = await precheck({
      capabilities: ['verify-ball-functional'],
      commitLedger: ledger(async () => [join(directory, 'notes.md')]),
    })

    expect(codes(rejected(verdict(report, 'verify-ball-functional', 'verify')))).toEqual(['commit-intent-open'])
  })

  test('without an evolution service there is no gate at all', async () => {
    const directory = await install('verify')
    const report = await precheck({ capabilities: ['verify-ball-functional'] })

    expect(providerRefusals(report)).toEqual([])
    expect(verdict(report, 'verify-ball-functional', 'verify').valid).toBe(true)
    expect(directory).toBe(join(checkout, '.agents', 'skills', 'verify'))
  })

  test('a ledger that cannot be read refuses every skill candidate, naming the reason (fail-closed)', async () => {
    const verifyDirectory = await install('verify')
    await install('ball-align')
    const read = vi.fn(async () => {
      throw new Error('evolution: this ledger could not be read')
    })
    const report = await precheck({
      capabilities: ['verify-ball-functional', 'design-ball'],
      commitLedger: ledger(read),
    })

    const refused = rejected(verdict(report, 'verify-ball-functional', 'verify'))
    expect(codes(refused)).toEqual(['commit-ledger-unreadable'])
    expect(refused.defects[0]!.detail).toContain('this ledger could not be read')
    expect(refused.defects[0]!.detail).toContain(join(verifyDirectory, 'SKILL.md'))
    expect(refused.defects[0]!.detail).toContain('fail-closed')
    // Fail-closed covers every candidate discovery found a directory for — the
    // state of the ledger is unknown, so none of them can be assumed clear…
    expect(codes(rejected(verdict(report, 'design-ball', 'ball-align')))).toEqual(['commit-ledger-unreadable'])
    // …while a skill that has no directory at all is still refused for what is
    // actually wrong with it, and the rest of the diagnostics are unaffected.
    const undiscoveredReport = await precheck({
      capabilities: ['design-ball'],
      table: { 'design-ball': { skills: ['missing-provider-skill'] } },
      commitLedger: ledger(read),
    })
    expect(codes(rejected(verdict(undiscoveredReport, 'design-ball', 'missing-provider-skill')))).toEqual(['skill-missing'])
    expect(read).toHaveBeenCalledTimes(2)
  })

  test('an evolution service that offers no target read is refused the same way, naming the missing read', async () => {
    await install('verify')
    const report = await precheck({ capabilities: ['verify-ball-functional'], commitLedger: {} })

    const refused = rejected(verdict(report, 'verify-ball-functional', 'verify'))
    expect(codes(refused)).toEqual(['commit-ledger-unreadable'])
    expect(refused.defects[0]!.detail).toContain('openIntentTargets()')
  })

  test('a service that offers only the file read is refused too (A6: the row read is required, fail-closed)', async () => {
    // A ledger whose rows cannot be read cannot be trusted to say "no capability
    // intent is open either": the version that half-answers is exactly the one a
    // half-product row would come from.
    await install('verify')
    const report = await precheck({
      capabilities: ['verify-ball-functional'],
      commitLedger: { openIntentTargets: async () => [] },
    })

    const refused = rejected(verdict(report, 'verify-ball-functional', 'verify'))
    expect(codes(refused)).toEqual(['commit-ledger-unreadable'])
    expect(refused.defects[0]!.detail).toContain('openIntentCapabilities()')
    expect(refused.defects[0]!.detail).toContain('fail-closed')
  })

  test('a capability row an open intent moves is refused by name, and only that row is affected', async () => {
    const directory = await install('verify')
    await install('ball-align')
    const read = vi.fn(async () => [join(directory, 'SKILL.md')])
    const rows = vi.fn(async () => ['verify-ball-functional'])
    const report = await precheck({
      capabilities: ['verify-ball-functional', 'design-ball'],
      commitLedger: ledger(read, rows),
    })

    // The refusal is keyed on the *row*: a row-only commit has no file to match
    // by directory, and nothing discovers a provider to hang a skill verdict on —
    // the row is what an open capability intent moves.
    const row = rowOf(report, 'verify-ball-functional')
    expect(row.refusals.map(defect => defect.code)).toEqual(['commit-intent-open'])
    expect(row.refusals[0]!.detail).toContain('verify-ball-functional')
    expect(row.refusals[0]!.detail).toContain('reconciliation')
    // The row is not resolved at all: nothing of a row that may not be admitted
    // is judged, and nothing of it can be recorded as something a run resolved.
    expect(row.skills).toEqual([])
    expect(providerRefusals(report)).toEqual([expect.stringContaining('capability "verify-ball-functional"')])
    expect(providerRefusals(report)[0]).toContain('commit-intent-open:')

    // Every other row is judged exactly as it is without a ledger at all.
    const withoutLedger = await precheck({ capabilities: ['design-ball'] })
    expect(verdict(report, 'design-ball', 'ball-align')).toEqual(verdict(withoutLedger, 'design-ball', 'ball-align'))
    expect(read).toHaveBeenCalledTimes(1)
    expect(rows).toHaveBeenCalledTimes(1)
  })

  test('a file target and a row of the same pre-check are two refusals, each in its own words', async () => {
    await install('verify')
    const report = await precheck({
      capabilities: ['verify-ball-functional'],
      commitLedger: ledger(
        async () => [join(checkout, '.agents', 'skills', 'verify', 'SKILL.md')],
        async () => ['verify-ball-functional'],
      ),
    })

    const row = rowOf(report, 'verify-ball-functional')
    expect(row.refusals.map(defect => defect.code)).toEqual(['commit-intent-open'])
    expect(row.skills).toEqual([])
  })

  test('no ledger write is ever performed: the gate reads the open targets and rows and nothing else', async () => {
    // The two methods the pre-check may call, with everything else on the service
    // a trap: a pre-check that reconciled, appended, or closed an intent would
    // fail here rather than pass silently.
    const directory = await install('verify')
    const calls: string[] = []
    const service = new Proxy({}, {
      get: (_target, property) => {
        calls.push(String(property))
        if (property === 'openIntentTargets') return async () => [join(directory, 'SKILL.md')]
        if (property === 'openIntentCapabilities') return async () => []
        return () => {
          throw new Error(`the pre-check called ${String(property)}`)
        }
      },
    }) as EvolutionCommitLedger

    const report = await precheck({ capabilities: ['verify-ball-functional'], commitLedger: service })
    expect(codes(rejected(verdict(report, 'verify-ball-functional', 'verify')))).toEqual(['commit-intent-open'])
    expect([...new Set(calls)].sort()).toEqual(['openIntentCapabilities', 'openIntentTargets'])
  })
})

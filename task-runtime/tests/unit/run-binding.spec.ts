import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CapabilityManifest, RunProviderBinding } from '../../../task/src/index.ts'
import { canonicalize, sha256Hex } from '../../../task/src/index.ts'
import type { CapabilityConfig } from '../../src/capability.ts'
import { DEPLOYMENT_MCP_SERVERS } from '../../../tests/support/mcp-servers.ts'
import { precheckProviders } from '../../src/provider-precheck.ts'
import type { ProviderPrecheck } from '../../src/provider-precheck.ts'
import { bindRunProviders, readRunBinding, RUN_BINDING_SKILLS_DIR } from '../../src/run-binding.ts'

/**
 * The run's content binding as a unit: identity, materialization, read-back and
 * the summary the three worker-facing views render. Everything here runs against
 * real skill directories (the pre-check's own fixtures) and a real tmp snapshot
 * root, and the assertions are on bytes read back from disk — never on the
 * module's own return value alone.
 */

const FIXTURE_SKILLS = fileURLToPath(new URL('../fixtures/skills/', import.meta.url))

/** The BB rows the fixtures are built against. */
const TABLE: Readonly<Record<string, CapabilityConfig>> = {
  'design-ball': { skills: ['ball-align'], tools: ['filesystem', 'bash'] },
  'verify-ball-functional': {
    skills: ['verify'],
    tools: ['filesystem', 'bash', 'jobs'],
    preset: 'bb-verify',
    mcpServers: ['bbdev'],
  },
}

const VERIFIER_REFS = ['command', 'composite', 'review']

let workspace: string
let home: string
let checkout: string
let root: string

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'run-binding-'))
  home = join(workspace, 'home')
  checkout = join(workspace, 'env')
  root = join(workspace, 'bindings')
  await mkdir(home, { recursive: true })
  await mkdir(checkout, { recursive: true })
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('HOME', home)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(workspace, { recursive: true, force: true })
})

/** Install one fixture skill where the pre-check's discovery reaches it. */
async function install(name: string, options: { sidecar?: boolean } = {}): Promise<string> {
  const directory = join(checkout, '.agents', 'skills', name)
  await cp(join(FIXTURE_SKILLS, name), directory, { recursive: true })
  if (options.sidecar === false) await rm(join(directory, 'SKILL.contract.json'))
  return directory
}

async function precheck(capabilities: readonly string[]): Promise<ProviderPrecheck> {
  return precheckProviders({
    capabilities,
    table: TABLE,
    view: { cwd: checkout },
    verifierRefs: VERIFIER_REFS,
  })
}

/** A manifest with the given rows, in the shape `resolveCapabilities` produces for them. */
function manifest(rows: Record<string, string[]>): CapabilityManifest {
  return {
    capabilities: Object.fromEntries(
      Object.entries(rows).map(([name, skills]) => [
        name,
        {
          skills,
          tools: [],
          ...(name === 'verify-ball-functional' ? { mcpServers: ['bbdev'] } : {}),
        },
      ]),
    ),
    missing: [],
    closure: 'closed',
  }
}

async function bind(options: {
  capabilities: readonly string[]
  rows: Record<string, string[]>
  runId?: string
  storeId?: string
  bindingRoot?: string | undefined
}): Promise<RunProviderBinding | undefined> {
  const providers = await precheck(options.capabilities)
  return bindRunProviders({
    storeId: options.storeId ?? 'sg-t-root',
    runId: options.runId ?? 'r-1',
    manifest: manifest(options.rows),
    providers,
    mcpRegistry: DEPLOYMENT_MCP_SERVERS,
    table: TABLE,
    root: 'bindingRoot' in options ? options.bindingRoot : root,
  })
}

/** Read one file out of a binding's snapshot, failing the test when it is not there. */
async function snapshotFile(binding: RunProviderBinding, relative: string): Promise<Buffer> {
  if (binding.snapshotRoot === undefined) throw new Error('the binding names no snapshot root')
  return readFile(join(binding.snapshotRoot, relative))
}

describe('bindRunProviders', () => {
  test("materializes the admitted bytes under the run's own directory and records their identity", async () => {
    const directory = await install('ball-align')
    const binding = (await bind({
      capabilities: ['design-ball'],
      rows: { 'design-ball': ['ball-align'] },
    })) as RunProviderBinding

    expect(binding.snapshotRoot).toBe(join(root, 'sg-t-root', 'r-1', RUN_BINDING_SKILLS_DIR))
    expect(binding.capabilities).toEqual(['design-ball'])
    expect(binding.mcpServers).toEqual([])
    expect(binding.skills).toHaveLength(1)
    const skill = binding.skills[0]!
    expect(skill.name).toBe('ball-align')
    expect(skill.role).toBe('knowledge')
    expect(skill.capabilities).toEqual(['design-ball'])
    // The description comes from the file's own frontmatter, not from the table.
    expect(skill.description).toContain('Align a Buckyball Ball')
    expect(skill.contractDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(skill.uncovered).toEqual([])

    // Bytes, not a claim about them: SKILL.md, the sidecar and every declared
    // resource were copied byte-for-byte, and the recorded content digest is the
    // digest of what stands in the snapshot — recomputed here from the copied
    // files, over the canonical form the identity is defined as.
    expect(await snapshotFile(binding, 'ball-align/SKILL.md')).toEqual(await readFile(join(directory, 'SKILL.md')))
    expect(await snapshotFile(binding, 'ball-align/SKILL.contract.json')).toEqual(
      await readFile(join(directory, 'SKILL.contract.json')),
    )
    expect(await snapshotFile(binding, 'ball-align/references/contract-checklist.md')).toEqual(
      await readFile(join(directory, 'references', 'contract-checklist.md')),
    )
    const digestOf = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
    const expected = createHash('sha256')
      .update(
        JSON.stringify({
          resources: [
            {
              path: 'references/contract-checklist.md',
              sha256: digestOf(await snapshotFile(binding, 'ball-align/references/contract-checklist.md')),
            },
            {
              path: 'references/illegal-input-table.md',
              sha256: digestOf(await snapshotFile(binding, 'ball-align/references/illegal-input-table.md')),
            },
          ],
          skillMdSha256: digestOf(await snapshotFile(binding, 'ball-align/SKILL.md')),
        }),
      )
      .digest('hex')
    expect(skill.contentDigest).toBe(expected)
  })

  test('reads the snapshot back clean, and names what changed when it does not', async () => {
    await install('ball-align')
    const binding = (await bind({
      capabilities: ['design-ball'],
      rows: { 'design-ball': ['ball-align'] },
    })) as RunProviderBinding

    expect((await readRunBinding(binding))?.defects).toEqual([])

    // One byte of the body, one byte of a resource, one byte of the declaration:
    // each is a separate identity, and each is reported by name.
    await writeFile(join(binding.snapshotRoot!, 'ball-align', 'SKILL.md'), 'rewritten\n')
    const body = await readRunBinding(binding)
    expect(body!.skills[0]!.readable).toBe(false)
    expect(body!.defects.join('\n')).toContain('content-mismatch')
    expect(body!.defects.join('\n')).toContain('bound ' + binding.skills[0]!.contentDigest)

    const restored = (await bind({
      capabilities: ['design-ball'],
      rows: { 'design-ball': ['ball-align'] },
      runId: 'r-2',
    })) as RunProviderBinding
    await writeFile(join(restored.snapshotRoot!, 'ball-align', 'references', 'illegal-input-table.md'), 'rewritten\n')
    const resource = await readRunBinding(restored)
    expect(resource!.defects.join('\n')).toContain('references/illegal-input-table.md')

    const declared = (await bind({
      capabilities: ['design-ball'],
      rows: { 'design-ball': ['ball-align'] },
      runId: 'r-3',
    })) as RunProviderBinding
    const sidecar = JSON.parse(
      await readFile(join(declared.snapshotRoot!, 'ball-align', 'SKILL.contract.json'), 'utf8'),
    ) as { scope: string }
    sidecar.scope = 'rewritten scope'
    await writeFile(join(declared.snapshotRoot!, 'ball-align', 'SKILL.contract.json'), JSON.stringify(sidecar))
    const contract = await readRunBinding(declared)
    expect(contract!.defects.join('\n')).toContain('sidecar-mismatch')

    // A directory the record does not name would be registered into a worker's
    // layer, so it is reported too.
    const extra = (await bind({
      capabilities: ['design-ball'],
      rows: { 'design-ball': ['ball-align'] },
      runId: 'r-4',
    })) as RunProviderBinding
    await mkdir(join(extra.snapshotRoot!, 'smuggled-skill'), { recursive: true })
    await writeFile(
      join(extra.snapshotRoot!, 'smuggled-skill', 'SKILL.md'),
      '---\nname: smuggled-skill\ndescription: not bound\n---\n\nbody\n',
    )
    const smuggled = await readRunBinding(extra)
    expect(smuggled!.defects.join('\n')).toContain('smuggled-skill')
    expect(smuggled!.defects.join('\n')).toContain("not a skill this run's record names")
  })

  test('a snapshot that is missing is reported, never substituted with the production path', async () => {
    await install('ball-align')
    const binding = (await bind({
      capabilities: ['design-ball'],
      rows: { 'design-ball': ['ball-align'] },
    })) as RunProviderBinding
    await rm(binding.snapshotRoot!, { recursive: true, force: true })

    const read = await readRunBinding(binding)
    expect(read!.skills[0]!.readable).toBe(false)
    expect(read!.defects.join('\n')).toContain(binding.snapshotRoot!)
    // The production skill is still there and still readable — the record does
    // not fall back to it, and nothing in the result mentions it.
    expect(await readFile(join(checkout, '.agents', 'skills', 'ball-align', 'SKILL.md'), 'utf8')).toContain(
      'ball-align',
    )
    expect(read!.defects.join('\n')).not.toContain(join(checkout, '.agents'))
  })

  test('refuses to bind when the admitted bytes moved after admission, naming the file', async () => {
    const directory = await install('ball-align')
    const providers = await precheck(['design-ball'])
    // The admission judgment is taken, then the production file is rewritten —
    // the window a long batch leaves open, injected here directly.
    await writeFile(join(directory, 'SKILL.md'), '---\nname: ball-align\ndescription: rewritten\n---\n\nnew body\n')

    await expect(
      bindRunProviders({
        storeId: 'sg-t-root',
        runId: 'r-1',
        manifest: manifest({ 'design-ball': ['ball-align'] }),
        providers,
        table: TABLE,
        root,
      }),
    ).rejects.toThrow(/SKILL\.md at .* is not the admitted content/)

    // Nothing half materialized: the run's directory is gone and no record exists.
    await expect(
      readFile(join(root, 'sg-t-root', 'r-1', RUN_BINDING_SKILLS_DIR, 'ball-align', 'SKILL.md')),
    ).rejects.toThrow()
  })

  test('refuses to bind into a run directory that already exists instead of overwriting it', async () => {
    await install('ball-align')
    const first = (await bind({
      capabilities: ['design-ball'],
      rows: { 'design-ball': ['ball-align'] },
      runId: 'r-1',
    })) as RunProviderBinding
    const recordBefore = await readFile(join(first.snapshotRoot!, 'ball-align', 'SKILL.md'))

    await expect(
      bind({ capabilities: ['design-ball'], rows: { 'design-ball': ['ball-align'] }, runId: 'r-1' }),
    ).rejects.toThrow(/already exists/)
    expect(await readFile(join(first.snapshotRoot!, 'ball-align', 'SKILL.md'))).toEqual(recordBefore)
  })

  test('refuses a provider the pre-check did not accept rather than binding it by discovery', async () => {
    // The row declares a skill that was never judged (the pre-check reports it
    // as missing): a run must not start against it.
    const providers = await precheck(['design-ball'])

    await expect(
      bindRunProviders({
        storeId: 'sg-t-root',
        runId: 'r-1',
        manifest: manifest({ 'design-ball': ['ball-align'] }),
        providers,
        table: TABLE,
        root,
      }),
    ).rejects.toThrow(/no accepted provider for skill "ball-align"/)
  })

  test('binds nothing for a caller that assembled its own plan, and nothing for a run with no rows', async () => {
    await install('ball-align')
    // No pre-check but rows in play: no judged identity, so no binding at all.
    expect(
      await bindRunProviders({
        storeId: 'sg-t-root',
        runId: 'r-1',
        manifest: manifest({ 'design-ball': ['ball-align'] }),
        table: TABLE,
        root,
      }),
    ).toBeUndefined()

    // No rows: the root case — a record with the table's revision and nothing else.
    const empty = await bindRunProviders({
      storeId: 'sg-t-root',
      runId: 'r-root',
      manifest: manifest({}),
      table: TABLE,
      root,
      mcpRegistry: DEPLOYMENT_MCP_SERVERS,
    })
    expect(empty!.skills).toEqual([])
    expect(empty!.capabilities).toEqual([])
    expect(empty!.mcpServers).toEqual([])
    expect(empty!.snapshotRoot).toBeUndefined()
    expect(empty!.registryRevision).toMatch(/^[0-9a-f]{64}$/)
    // Nothing was materialized for it.
    await expect(readFile(join(root, 'sg-t-root', 'r-root'))).rejects.toThrow()
  })

  test('records the granted MCP servers with the template identity they resolve through', async () => {
    await install('verify')
    const binding = (await bind({
      capabilities: ['verify-ball-functional'],
      rows: { 'verify-ball-functional': ['verify'] },
    })) as RunProviderBinding
    expect(binding.skills[0]!.role).toBe('execution-provider')
    expect(binding.mcpServers[0]!.serverName).toBe('bbdev')
    // The digest tracks the registry template: the same name over an edited
    // template is a different identity, and the record says so.
    expect(binding.mcpServers[0]!.templateDigest).toBe(sha256Hex(canonicalize(DEPLOYMENT_MCP_SERVERS['bbdev'])))
    const edited = await bindRunProviders({
      storeId: 'sg-t-root',
      runId: 'r-edited',
      manifest: manifest({ 'verify-ball-functional': ['verify'] }),
      providers: await precheck(['verify-ball-functional']),
      table: TABLE,
      root,
      mcpRegistry: { bbdev: { ...DEPLOYMENT_MCP_SERVERS['bbdev'], command: 'somewhere/else.sh' } },
    })
    expect(edited!.mcpServers[0]!.templateDigest).not.toBe(binding.mcpServers[0]!.templateDigest)
  })

  test('refuses a skill whose directory is not readable as the admitted bytes, without leaving a snapshot', async () => {
    const directory = await install('ball-align')
    const providers = await precheck(['design-ball'])
    // A symbolic link where the body was: the verified walk refuses to follow it.
    await rm(join(directory, 'SKILL.md'))
    await symlink(join(FIXTURE_SKILLS, 'verify', 'SKILL.md'), join(directory, 'SKILL.md'))

    await expect(
      bindRunProviders({
        storeId: 'sg-t-root',
        runId: 'r-1',
        manifest: manifest({ 'design-ball': ['ball-align'] }),
        providers,
        table: TABLE,
        root,
      }),
    ).rejects.toThrow(/symbolic link/)
    await expect(readFile(join(root, 'sg-t-root', 'r-1'))).rejects.toThrow()
  })
})

describe('run binding re-checks', () => {
  test('re-reads what a guidance snapshot leaves uncovered, in both directions', async () => {
    const directory = await install('ball-align', { sidecar: false })
    await writeFile(join(directory, 'notes.md'), 'not covered\n')
    const binding = (await bind({
      capabilities: ['design-ball'],
      rows: { 'design-ball': ['ball-align'] },
    })) as RunProviderBinding
    expect(binding.skills[0]!.uncovered).toEqual(['notes.md'])
    // A snapshot holding exactly what was admitted reads back clean. The source's
    // uncovered entry is deliberately not part of it: a snapshot carries the
    // bound content identity's files.
    expect((await readRunBinding(binding))!.defects).toEqual([])
    // The identity's own files — the body and its declared resources — and
    // nothing else: the source's uncovered entry was left behind on purpose.
    expect((await readdir(join(binding.snapshotRoot!, 'ball-align'))).sort()).toEqual(['SKILL.md', 'references'])

    // A root-level entry that appeared in the snapshot after admission: the
    // identity does not cover it, so the record does not describe this directory.
    await writeFile(join(binding.snapshotRoot!, 'ball-align', 'extra.md'), 'added after admission\n')
    const added = await readRunBinding(binding)
    expect(added!.skills[0]!.readable).toBe(false)
    expect(added!.defects.join('\n')).toContain('content-mismatch')
    expect(added!.defects.join('\n')).toContain('"extra.md"')
    await rm(join(binding.snapshotRoot!, 'ball-align', 'extra.md'))

    // The same rule for a name the record knows as uncovered in the source: a
    // snapshot must carry bound content only, so its reappearance here is
    // reported — and named as the entry the record already flagged.
    await writeFile(join(binding.snapshotRoot!, 'ball-align', 'notes.md'), 'not covered\n')
    const restored = await readRunBinding(binding)
    expect(restored!.skills[0]!.readable).toBe(false)
    expect(restored!.defects.join('\n')).toContain('content-mismatch')
    expect(restored!.defects.join('\n')).toContain('"notes.md"')
    expect(restored!.defects.join('\n')).toContain('lists it as uncovered in the source skill')
    await rm(join(binding.snapshotRoot!, 'ball-align', 'notes.md'))

    // A change at the production path is not this check's business: a run loads
    // its snapshot, and the record is re-read against that snapshot only.
    await rm(join(directory, 'notes.md'))
    expect((await readRunBinding(binding))!.defects).toEqual([])

    // Deleting the bound body itself is not silent either — the direction that
    // was already named by the identity check.
    await rm(join(binding.snapshotRoot!, 'ball-align', 'SKILL.md'))
    const deleted = await readRunBinding(binding)
    expect(deleted!.skills[0]!.readable).toBe(false)
    expect(deleted!.defects.join('\n')).toContain('skill-missing')
  })
})

import { cp, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const checkout = fileURLToPath(new URL('../../', import.meta.url))
const buildScript = fileURLToPath(new URL('../build.mjs', import.meta.url))
const run = promisify(execFile)
const { buildAssembly, checkBuild }: {
  buildAssembly(root: string): Promise<void>
  checkBuild(root: string): Promise<void>
} = await import(buildScript)

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'singularity-build-'))
  roots.push(root)
  await mkdir(join(root, 'assembly/src'), { recursive: true })
  await mkdir(join(root, 'src'))
  await mkdir(join(root, 'scripts'))
  for (const file of ['deploy.mjs', 'dsh-control-runtime.mjs']) await cp(join(checkout, 'scripts', file), join(root, 'scripts', file))
  await cp(join(checkout, 'deployment/profile'), join(root, 'deployment/profile'), { recursive: true })
  await symlink(join(checkout, 'node_modules'), join(root, 'node_modules'))
  for (const file of ['package.json', 'pnpm-lock.yaml']) await cp(join(checkout, file), join(root, file))
  await cp(join(checkout, 'assembly/package.json'), join(root, 'assembly/package.json'))
  await cp(join(checkout, 'assembly/presets'), join(root, 'assembly/presets'), { recursive: true })
  for (const file of ['client.js', 'panel.js', 'panel.css', 'panel.html', 'cordis.patch.yml', 'build.mjs'])
    await cp(join(checkout, 'assembly', file), join(root, 'assembly', file))
  const compilerOptions = { module: 'nodenext', target: 'es2023', strict: true, noEmit: true, skipLibCheck: true,
    allowImportingTsExtensions: true }
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['src'] }))
  await writeFile(join(root, 'assembly/tsconfig.json'), JSON.stringify({ compilerOptions, include: ['src'] }))
  await writeFile(join(root, 'src/value.ts'), 'export const value: number = 1\n')
  for (const entry of ['index', 'agent', 'web']) await writeFile(join(root, `assembly/src/${entry}.ts`),
    `import { value } from '../../src/value.ts'\nexport function apply() { return value }\n`)
  return root
}

describe('the deployable build', () => {
  it('loads all host exports and lets the native DSH client registry serve the exported client', async () => {
    const root = await fixture()
    await buildAssembly(root)
    await expect(checkBuild(root)).resolves.toBeUndefined()
    const home = join(root, 'private-home')
    await run(process.execPath, [join(root, 'scripts/deploy.mjs')], { env: { ...process.env, DSH_HOME: home } })
    const profile = JSON.parse(await readFile(join(home, 'profiles/singularity-next-web/package.json'), 'utf8')) as { name: string }
    expect(profile.name).toBe('singularity-next-web')
  }, 30_000)

  it.each(['src/value.ts', 'assembly/client.js', 'assembly/panel.js', 'assembly/lib/web.js'])(
    'rejects changed %s even if its modification time is preserved', async file => {
      const root = await fixture()
      await buildAssembly(root)
      const path = join(root, file)
      const previous = await stat(path)
      await writeFile(path, await readFile(path, 'utf8') + '\n// changed after build\n')
      await utimes(path, previous.atime, previous.mtime)
      await expect(checkBuild(root)).rejects.toThrow(/changed|stale/)
    }, 30_000)

  it.each(['assembly/lib/web.js', 'assembly/client.js'])('rejects the missing %s export', async file => {
    const root = await fixture()
    await buildAssembly(root)
    await rm(join(root, file))
    await expect(checkBuild(root)).rejects.toThrow()
  }, 30_000)

  it.each(['src/value.ts', 'assembly/src/agent.ts'])('rejects a type error in %s before writing build output', async file => {
    const root = await fixture()
    await writeFile(join(root, file), 'export const invalid: number = "type error"\n')
    await expect(buildAssembly(root)).rejects.toThrow()
    await expect(stat(join(root, 'assembly/lib'))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 30_000)

  it('rejects stale deployment before replacing the existing private profile', async () => {
    const root = await fixture()
    await buildAssembly(root)
    const home = join(root, 'private-home')
    const profile = join(home, 'profiles/singularity-next-web')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'sentinel'), 'existing deployment')
    await writeFile(join(root, 'src/value.ts'), 'export const value = 2\n')
    await expect(run(process.execPath, [join(root, 'scripts/deploy.mjs')], { env: { ...process.env, DSH_HOME: home } }))
      .rejects.toThrow(/stale/)
    expect(await readFile(join(profile, 'sentinel'), 'utf8')).toBe('existing deployment')
  }, 30_000)

  it('materialises a profile whose assembly row carries every key the plugin schema requires', async () => {
    const root = await fixture()
    await buildAssembly(root)
    const home = join(root, 'private-home')
    await run(process.execPath, [join(root, 'scripts/deploy.mjs')], { env: { ...process.env, DSH_HOME: home } })
    const patch = await readFile(join(home, 'profiles/singularity-next-web/cordis.patch.yml'), 'utf8')
    // The plugin's Config marks all of these required and an id-targeted patch replaces the whole
    // config, so a template without them composes a row the host refuses to activate — and that
    // refusal is invisible to every check that only reads this checkout.
    for (const key of ['controlId', 'domainDir', 'workspaceRoot']) expect(patch).toContain(key + ':')
    for (const key of ['rootSolves', 'children', 'childRuns', 'nativeTokens']) expect(patch).toContain(key + ':')
  }, 30_000)

  it('declares the gateway retry policy the measured transport failure needs', async () => {
    const patch = await readFile(join(checkout, 'deployment/profile/cordis.patch.yml'), 'utf8')
    // `stream_read_error` is this gateway's text for a dropped upstream stream, and the pi-ai
    // classifier falls through to `PI_AI_ERROR` for it — a code outside the host's default
    // retryable set, which made one dropped stream terminal for a whole Run. The route therefore has
    // to name the policy itself; deleting this block restores the measured defect.
    const policy = patch.slice(patch.indexOf('retryPolicy:'))
    expect(policy).toContain('mode: normal')
    expect(policy).toContain('maxRetries: 5')
    expect(policy).toContain('PI_AI_ERROR')
    for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) expect(policy).toContain(code)
  })
})

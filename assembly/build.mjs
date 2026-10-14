#!/usr/bin/env node
/** Typecheck both packages, bundle host exports, and bind every shipped asset to its source bytes. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import { build } from 'vite'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FACES = ['.', './agent', './web', './client']
const RECORD = 'assembly/lib/build.json'

async function filesAt(root, directory) {
  const files = []
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory + '/' + entry.name
    files.push(...entry.isDirectory() ? await filesAt(root, path) : [path])
  }
  return files.sort()
}

async function inputsAt(root) {
  return [...await filesAt(root, 'src'), ...await filesAt(root, 'assembly/src'), ...await filesAt(root, 'assembly/frontend'), ...await filesAt(root, 'assembly/presets'),
    'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'assembly/tsconfig.json', 'assembly/build.mjs', 'assembly/package.json',
    'assembly/client.js', 'assembly/review.mjs', 'assembly/panel.html', 'assembly/cordis.patch.yml'].sort()
}

async function hashes(root, files) {
  return Object.fromEntries(await Promise.all(files.map(async file =>
    [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])))
}

async function loadExports(root) {
  const packageFile = join(root, 'assembly/package.json')
  const manifest = JSON.parse(await readFile(packageFile, 'utf8'))
  const resolvePackage = createRequire(packageFile)
  for (const face of FACES) {
    assert.equal(typeof manifest.exports[face], 'string', 'assembly/package.json must export ' + face)
    const path = resolvePackage.resolve(manifest.name + (face === '.' ? '' : face.slice(1)))
    if (face === './client') new Script(await readFile(path, 'utf8'), { filename: path })
    else assert.equal(typeof (await import(pathToFileURL(path).href)).apply, 'function', face + ' has no plugin apply export')
  }
  const { DSH_INSTALLED } = await import('../scripts/dsh-control-runtime.mjs')
  const privatePackages = createRequire(join(DSH_INSTALLED, 'resolve.cjs'))
  const load = name => import(pathToFileURL(privatePackages.resolve(name)).href)
  const [{ Context }, { Loader }, { ClientModuleRegistry }] = await Promise.all([
    load('@deepseek-ai/cordis'), load('@deepseek-ai/cordis-plugin-loader'), load('@deepseek-ai/dsh-client-modules'),
  ])
  const context = new Context()
  try {
    await context.plugin(Loader, { baseUrl: pathToFileURL(packageFile).href })
    await context.loader.create({ name: manifest.name, config: {} })
    await context.loader.await()
    await context.plugin(ClientModuleRegistry)
    const modules = context.get('clientModules')
    assert.equal(modules.clientPath(manifest.name), resolvePackage.resolve(manifest.name + '/client'))
    const entry = modules.graph().entries.find(entry => entry.id === manifest.name)
    const response = await modules.fetchBundle(new Request(new URL(entry.url, 'http://build.local')))
    assert.equal(response.status, 200, 'native client registry refused the built client')
    assert((await response.text()).includes(await readFile(modules.clientPath(manifest.name), 'utf8')),
      'native client registry did not serve the exported client bytes')
  } finally { await context.fiber.dispose() }
}

export async function checkBuild(root = ROOT) {
  const record = JSON.parse(await readFile(join(root, RECORD), 'utf8'))
  assert.deepEqual(await hashes(root, await inputsAt(root)), record.inputs, 'assembly build is stale: source bytes changed')
  const outputs = (await filesAt(root, 'assembly/lib')).filter(file => file !== RECORD)
  assert.deepEqual(await hashes(root, outputs), record.outputs, 'assembly build is stale: artifact bytes changed')
  await import('../scripts/dsh-control-runtime.mjs')
  await loadExports(root)
}

export async function buildAssembly(root = ROOT) {
  const inputs = await hashes(root, await inputsAt(root))
  for (const config of ['tsconfig.json', 'assembly/tsconfig.json', 'assembly/frontend/tsconfig.json'])
    execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '-p', config],
      { cwd: root, stdio: 'inherit' })
  const here = join(root, 'assembly')
  await build({
    configFile: false, root: here, logLevel: 'warn',
    build: {
      outDir: join(here, 'lib'), emptyOutDir: true, minify: false, target: 'node22',
      lib: {
        entry: { index: join(here, 'src/index.ts'), agent: join(here, 'src/agent.ts'), web: join(here, 'src/web.ts') },
        formats: ['es'], fileName: (_format, entryName) => `${entryName}.js`,
      },
      rollupOptions: { external: id => id.startsWith('@deepseek-ai/') || id.startsWith('node:') },
    },
  })
  await build({ configFile: false, root: here, logLevel: 'warn',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    build: { outDir: join(here, 'lib/panel'), emptyOutDir: true,
      lib: { entry: join(here, 'frontend/panel.tsx'), formats: ['es'], fileName: () => 'panel.js', cssFileName: 'panel' },
      rollupOptions: { output: { codeSplitting: false } },
    },
  })
  assert.deepEqual(await hashes(root, await inputsAt(root)), inputs, 'source bytes changed during the build')
  const outputs = await hashes(root, await filesAt(root, 'assembly/lib'))
  await writeFile(join(root, RECORD), JSON.stringify({ inputs, outputs }, null, 2) + '\n')
  await checkBuild(root)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await (process.argv.includes('--check') ? checkBuild() : buildAssembly())
  console.log('assembly: root + assembly checked; ./agent, ./web, ./client and root export loadable; source/artifact digests verified')
}

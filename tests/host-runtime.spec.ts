import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'

const runtimeModule = new URL('../scripts/host-runtime.mjs', import.meta.url)
const { runHost } = await import(fileURLToPath(runtimeModule))
const temporary: string[] = [], children = new Set<ChildProcess>(), nativePids = new Set<number>()
const patchPath = fileURLToPath(new URL('../deployment/runtime.patch.yml', import.meta.url))

afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  children.clear()
  for (const pid of nativePids) {
    try { process.kill(pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  nativePids.clear()
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function temp() {
  const root = await mkdtemp(join(tmpdir(), 'singularity-host-runtime-'))
  temporary.push(root)
  return root
}

async function waitForJson(path: string): Promise<Record<string, any>> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('Native stub did not write its observation: ' + path)
}

async function stubAt(root: string) {
  const path = join(root, 'native stub.mjs')
  await writeFile(path, `#!${process.execPath}
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
await writeFile(join(tmpdir(), 'native-intermediate'), 'disposable native output')
const observed = {
  pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), tmp: tmpdir(),
  temps: [process.env.TMPDIR, process.env.TMP, process.env.TEMP],
  home: process.env.DSH_HOME, ceiling: process.env.GIT_CEILING_DIRECTORIES,
  cwdGit: spawnSync('git', ['rev-parse', '--show-toplevel'], {encoding:'utf8'}).status,
  homeGit: spawnSync('git', ['-C', process.env.DSH_HOME, 'rev-parse', '--show-toplevel'], {encoding:'utf8'}).status,
  explicitGit: spawnSync('git', ['-C', process.env.TEST_PARENT, 'rev-parse', '--show-toplevel'], {encoding:'utf8'}).stdout.trim(),
  localGitEnvironment: Object.keys(process.env).filter(key => /^GIT_(DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|INDEX_FILE|CONFIG_COUNT|CONFIG_KEY_0|CONFIG_VALUE_0)$/.test(key)),
}
await writeFile(process.env.TEST_OBSERVATION, JSON.stringify(observed))
if (process.env.TEST_WAIT === 'yes') {
  while (true) {
    try { await readFile(process.env.TEST_RELEASE); break } catch (error) { if(error.code !== 'ENOENT') throw error }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
process.exitCode = Number(process.env.TEST_EXIT ?? '0')
`, { mode: 0o700 })
  return path
}

async function fixture() {
  const root = await temp(), home = join(root, 'native home'), cwd = join(root, 'working directory')
  await mkdir(home); await mkdir(cwd)
  execFileSync('git', ['init', '--quiet', root])
  await mkdir(join(home, 'sessions')); await mkdir(join(home, 'evidence'))
  await writeFile(join(home, 'sessions/retained.jsonl'), 'session evidence\n')
  await writeFile(join(home, 'evidence/result.json'), '{"retained":true}\n')
  return { root, home, cwd, binary: await stubAt(root),
    env: { ...process.env, TEST_PARENT: root, TEST_OBSERVATION: join(root, 'observed.json') } }
}

it.each([0, 7])('isolates native temporary files and parent Git discovery, preserving evidence after exit %s', async code => {
  const f = await fixture(), args = ['--profile', 'stub-profile', 'literal space', '$(do not execute)', '--patch', '/existing patch.yml']
  const result = await runHost({ home: f.home, binary: f.binary, args, cwd: f.cwd, stdio: 'ignore', env: {
    ...f.env, TEST_EXIT: String(code), DSH_HOME: join(f.root, 'wrong home'),
    TMPDIR: f.root, TMP: f.root, TEMP: f.root,
    GIT_DIR: join(f.root, '.git'), GIT_WORK_TREE: f.root, GIT_COMMON_DIR: join(f.root, '.git'),
    GIT_INDEX_FILE: join(f.root, '.git/index'), GIT_OBJECT_DIRECTORY: join(f.root, '.git/objects'),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: join(f.root, '.git/objects'), GIT_CEILING_DIRECTORIES: '/',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: f.root,
  } })
  expect(result).toEqual({ code, signal: null })
  const observed = await waitForJson(f.env.TEST_OBSERVATION)
  expect(observed.args).toEqual([
    '--profile', 'stub-profile', '--patch', '/existing patch.yml', '--patch', patchPath,
    'literal space', '$(do not execute)',
  ])
  expect(isAbsolute(observed.args[5])).toBe(true)
  expect(observed.home).toBe(await realpath(f.home))
  expect(observed.temps).toEqual([observed.tmp, observed.tmp, observed.tmp])
  expect(dirname(observed.tmp)).toBe(join(await realpath(f.home), '.singularity-runtime'))
  expect(observed.tmp.split('/').at(-1)).toMatch(/^tmp-[A-Za-z0-9]{6}$/)
  expect(observed.cwdGit).not.toBe(0); expect(observed.homeGit).not.toBe(0)
  expect(observed.explicitGit).toBe(await realpath(f.root))
  expect(new Set(observed.ceiling.split(delimiter))).toEqual(new Set([
    await realpath(f.cwd), dirname(await realpath(f.cwd)), await realpath(f.home), dirname(await realpath(f.home)),
  ]))
  expect(observed.localGitEnvironment).toEqual([])
  await expect(readdir(observed.tmp)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.home, 'sessions/retained.jsonl'), 'utf8')).toBe('session evidence\n')
  expect(await readFile(join(f.home, 'evidence/result.json'), 'utf8')).toBe('{"retained":true}\n')
  const patch = await readFile(patchPath, 'utf8')
  expect(patch).toContain('workspace-changes')
  expect(patch).toMatch(/^\s*-\s*id:\s*workspace-changes\s*\n\s*disabled:\s*true\s*$/m)
})

it('places user overlays and the safety patch before web options while preserving application argument order', async () => {
  const f = await fixture()
  const result = await runHost({ home: f.home, binary: f.binary, cwd: f.cwd, stdio: 'ignore', env: f.env,
    args: ['--host', '127.0.0.1', '--port', '7341', '--patch', '/user overlay.yml'] })
  expect(result).toEqual({ code: 0, signal: null })
  const observed = await waitForJson(f.env.TEST_OBSERVATION)
  expect(observed.args).toEqual([
    '--profile', 'singularity-next-web', '--patch', '/user overlay.yml', '--patch', patchPath,
    '--host', '127.0.0.1', '--port', '7341',
  ])
  // The native launcher stops parsing overlays at --host: the safety overlay
  // must already have been consumed when web-application parsing begins.
  expect(observed.args.indexOf(patchPath)).toBeLessThan(observed.args.indexOf('--host'))
})

it('retains equals-form launcher options and their order without inserting a second profile', async () => {
  const f = await fixture()
  const result = await runHost({ home: f.home, binary: f.binary, cwd: f.cwd, stdio: 'ignore', env: f.env,
    args: ['--host=127.0.0.1', '--profile=custom-profile', '--patch=/user overlay.yml', '--port=7342',
      '--from-default-profile=web', '--dump-config'] })
  expect(result).toEqual({ code: 0, signal: null })
  const observed = await waitForJson(f.env.TEST_OBSERVATION)
  expect(observed.args).toEqual([
    '--profile=custom-profile', '--patch=/user overlay.yml', '--from-default-profile=web', '--dump-config',
    '--patch', patchPath, '--host=127.0.0.1', '--port=7342',
  ])
})

it.each(['--dump-config-schema', '--dump-default-config'])('keeps launcher diagnostic %s before application arguments', async diagnostic => {
  const f = await fixture()
  await runHost({ home: f.home, binary: f.binary, cwd: f.cwd, stdio: 'ignore', env: f.env,
    args: ['--host', '127.0.0.1', '--from-default-profile', 'web', diagnostic] })
  const observed = await waitForJson(f.env.TEST_OBSERVATION)
  expect(observed.args).toEqual([
    '--profile', 'singularity-next-web', '--from-default-profile', 'web', diagnostic,
    '--patch', patchPath, '--host', '127.0.0.1',
  ])
})

it('refuses a concurrent host without removing the first host temporary data', async () => {
  const f = await fixture(), release = join(f.root, 'release')
  const first = runHost({ home: f.home, binary: f.binary, args: [], cwd: f.cwd, stdio: 'ignore',
    env: { ...f.env, TEST_WAIT: 'yes', TEST_RELEASE: release } })
  try {
    const observed = await waitForJson(f.env.TEST_OBSERVATION)
    expect(observed.args).toEqual(['--profile', 'singularity-next-web', '--patch', patchPath])
    await expect(runHost({ home: f.home, binary: f.binary, args: [], cwd: f.cwd, stdio: 'ignore',
      env: { ...f.env, TEST_OBSERVATION: join(f.root, 'second.json') } })).rejects.toThrow()
    expect(await readFile(join(observed.tmp, 'native-intermediate'), 'utf8')).toBe('disposable native output')
    await expect(readFile(join(f.root, 'second.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await writeFile(release, 'finish'); await first }
})

it('cleans only owned six-character temporary directories left by a killed host', async () => {
  const f = await fixture(), launcher = join(f.root, 'launcher.mjs')
  const options = { home: f.home, binary: f.binary, args: [], cwd: f.cwd, stdio: 'ignore' }
  await writeFile(launcher, `import {runHost} from ${JSON.stringify(runtimeModule.href)}
await runHost({...${JSON.stringify(options)},env:process.env})
`)
  // Keep native state alive long enough to kill its owning launcher abruptly.
  const child = spawn(process.execPath, [launcher], { stdio: 'ignore', env: { ...f.env, TEST_WAIT: 'yes', TEST_RELEASE: join(f.root, 'never') } })
  children.add(child)
  const closed = new Promise(resolve => child.once('close', resolve))
  const observed = await waitForJson(f.env.TEST_OBSERVATION)
  nativePids.add(observed.pid)
  child.kill('SIGKILL'); await closed
  // The native host inherits the lock: killing only the launcher must not make
  // its still-running host's scratch reclaimable by a second launcher.
  await expect(runHost({ home: f.home, binary: f.binary, args: [], cwd: f.cwd, stdio: 'ignore',
    env: { ...f.env, TEST_OBSERVATION: join(f.root, 'second.json') } })).rejects.toThrow()
  process.kill(observed.pid, 'SIGKILL'); nativePids.delete(observed.pid)
  const deadline = Date.now() + 5000
  while (true) {
    try {
      const status = await readFile(`/proc/${observed.pid}/stat`, 'utf8')
      if (status.slice(status.lastIndexOf(')') + 2).startsWith('Z')) break
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error }
    if (Date.now() >= deadline) throw new Error('Killed native host did not release its process')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  expect(await readFile(join(observed.tmp, 'native-intermediate'), 'utf8')).toBe('disposable native output')
  const manual = join(f.home, '.singularity-runtime/tmp-keep-not-owned')
  await mkdir(manual); await writeFile(join(manual, 'retain'), 'manual evidence')
  const result = await runHost({ home: f.home, binary: f.binary, args: [], cwd: f.cwd, stdio: 'ignore', env: f.env })
  expect(result).toEqual({ code: 0, signal: null })
  await expect(readdir(observed.tmp)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(manual, 'retain'), 'utf8')).toBe('manual evidence')
})

it('rejects a symlinked runtime root without touching its target', async () => {
  const f = await fixture(), outside = join(f.root, 'outside')
  await mkdir(outside); await writeFile(join(outside, 'retain'), 'outside evidence')
  await symlink(outside, join(f.home, '.singularity-runtime'), 'dir')
  await expect(runHost({ home: f.home, binary: f.binary, args: [], cwd: f.cwd, stdio: 'ignore', env: f.env })).rejects.toThrow()
  expect(await readFile(join(outside, 'retain'), 'utf8')).toBe('outside evidence')
  await expect(readFile(f.env.TEST_OBSERVATION)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('aborts the native process and cleans its dedicated temporary directory', async () => {
  const f = await fixture(), controller = new AbortController()
  const running = runHost({ home: f.home, binary: f.binary, args: [], cwd: f.cwd, stdio: 'ignore',
    env: { ...f.env, TEST_WAIT: 'yes', TEST_RELEASE: join(f.root, 'never') }, signal: controller.signal })
  const observed = await waitForJson(f.env.TEST_OBSERVATION)
  controller.abort(new Error('test cancellation'))
  const result = await running
  expect(result.signal !== null || result.code !== 0).toBe(true)
  await expect(readdir(observed.tmp)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.home, 'evidence/result.json'), 'utf8')).toContain('retained')
})

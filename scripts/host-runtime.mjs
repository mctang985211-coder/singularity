#!/usr/bin/env node
/** Launch the native host with an owned temporary directory and an OS lifetime lock. */
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hostFindings, hostInstall } from './host-config.mjs'

const safetyPatch = fileURLToPath(new URL('../deployment/runtime.patch.yml', import.meta.url))

// DSH stops parsing launcher options at the first web-app argument. Keep all
// overlays before --host/--port, with our overlay last among the launcher patches.
function nativeArguments(args) {
  const launch = [], app = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (/^--(?:profile|patch|from-default-profile)(?:=|$)/.test(arg)) {
      launch.push(arg)
      if (!arg.includes('=')) {
        if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${arg} requires a value`)
        launch.push(args[++i])
      }
    } else if (['--dump-config', '--dump-config-schema', '--dump-default-config'].includes(arg)) launch.push(arg)
    else app.push(arg)
  }
  if (!launch.some(arg => arg === '--profile' || arg.startsWith('--profile='))) launch.unshift('--profile', 'singularity-next-web')
  return [...launch, '--patch', safetyPatch, ...app]
}

async function ownedDirectory(path) {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid())
    throw new Error(`Runtime directory must be an owned directory, not a symlink: ${path}`)
}

/** Linux flock locks the inherited open-file description, held by both launcher and host. */
async function lockHost(file) {
  const lock = await open(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    const entry = await lock.stat()
    if (!entry.isFile() || entry.uid !== process.getuid()) throw new Error('Host lock must be an owned regular file')
    const code = await new Promise((done, reject) => {
      const child = spawn('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', lock.fd] })
      child.once('error', reject)
      child.once('close', done)
    })
    if (code !== 0) throw new Error('A managed host already owns this DSH_HOME, or flock could not acquire its lock')
    return lock
  } catch (error) { await lock.close(); throw error }
}

/** Keep sessions, sealed artifacts and logs; remove only this launcher's disposable scratch. */
export async function runHost({ home, binary, args = [], cwd = process.cwd(), env = process.env,
  stdio = 'inherit', signal } = {}) {
  signal?.throwIfAborted()
  if (args.includes('--')) throw new Error('Pass native host options directly, without a -- separator')
  const invocation = nativeArguments(args)
  home ??= env.DSH_HOME
  if (!home) throw new Error('An explicit private DSH_HOME is required')
  home = resolve(home)
  if ([homedir(), join(homedir(), '.dsh'), '/'].includes(home)) throw new Error('Use a dedicated private DSH_HOME')
  await mkdir(home, { recursive: true, mode: 0o700 })
  home = await realpath(home)
  if ([await realpath(homedir()), join(await realpath(homedir()), '.dsh'), '/'].includes(home))
    throw new Error('Use a dedicated private DSH_HOME')
  cwd = await realpath(cwd)
  if (!binary) {
    const installed = hostInstall(), findings = hostFindings(installed)
    if (findings.length) throw new Error(findings.join('; '))
    binary = env.DSH_BIN || join(dirname(installed), '.bin', 'dsh')
  }
  const runtime = join(home, '.singularity-runtime')
  await ownedDirectory(runtime)
  const lock = await lockHost(join(runtime, 'host.lock'))
  let temporary
  try {
    // A killed launch can leave scratch behind. The inherited lock prevents reclaiming a live host's files.
    for (const entry of await readdir(runtime, { withFileTypes: true })) {
      if (!/^tmp-[a-zA-Z0-9]{6}$/.test(entry.name)) continue
      const path = join(runtime, entry.name), metadata = await lstat(path)
      if (!entry.isDirectory() || entry.isSymbolicLink() || metadata.uid !== process.getuid())
        throw new Error(`Refusing unexpected scratch entry: ${path}`)
      await rm(path, { recursive: true, force: true })
    }
    temporary = await mkdtemp(join(runtime, 'tmp-'))
    const nativeEnv = { ...env, DSH_HOME: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
      GIT_CEILING_DIRECTORIES: [cwd, dirname(cwd), home, dirname(home)].join(':') }
    for (const key of Object.keys(nativeEnv))
      if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|INDEX_FILE|CONFIG.*)$/.test(key)) delete nativeEnv[key]
    return await new Promise((done, reject) => {
      // FD 3 keeps the lock held even if this launcher is killed before the native host exits.
      const child = spawn(binary, invocation, {
        cwd, env: nativeEnv, stdio: [stdio, stdio, stdio, lock.fd],
      })
      let timer
      const stop = signal => {
        child.kill(signal)
        timer ??= setTimeout(() => child.kill('SIGKILL'), 10_000).unref()
      }
      const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM')
      process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
      signal?.addEventListener('abort', terminate, { once: true })
      if (signal?.aborted) terminate()
      child.once('error', reject)
      child.once('close', (code, termination) => {
        clearTimeout(timer)
        process.off('SIGINT', interrupt); process.off('SIGTERM', terminate)
        signal?.removeEventListener('abort', terminate)
        done({ code, signal: termination })
      })
    })
  } finally {
    try { if (temporary) await rm(temporary, { recursive: true, force: true }) }
    finally { await lock.close() }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runHost({ args: process.argv.slice(2) })
    process.exitCode = result.code ?? (result.signal === 'SIGINT' ? 130 : 143)
  } catch (error) {
    console.error(`host: ${error.message}`)
    process.exitCode = 1
  }
}

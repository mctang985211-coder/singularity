import { existsSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { confinedArgv, type BubbleWorld } from './bubble.ts'
import { spawn, type SpawnOptions } from 'node:child_process'
import type { VerifierInvocation } from '../../src/verifier/command.ts'

export function spawnProcess(
  invocation: VerifierInvocation,
  signal?: AbortSignal,
  cwd?: string,
  world?: BubbleWorld,
): Promise<{
  exitCode: number | null
  stdout: string
  stderr: string
  failure?: string
}> {
  signal?.throwIfAborted()
  const argv = invocation.shell ? ['/bin/bash', '-c', invocation.command] : [...invocation.argv]
  if (isAbsolute(argv[0]!) && !existsSync(argv[0]!))
    return Promise.resolve({
      exitCode: null,
      stdout: '',
      stderr: '',
      failure: `process-execution-failed: ENOENT ${argv[0]}`,
    })
  const directory = cwd ?? dirname(argv[1] !== undefined && isAbsolute(argv[1]) ? argv[1] : process.execPath)
  const policy = world ?? {
    root: directory,
    writable: cwd !== undefined,
    protected: [],
    references: argv
      .filter(arg => isAbsolute(arg))
      .map(path => dirname(path))
      .filter(path => path !== '/'),
  }
  const confined = confinedArgv(argv, policy, directory)
  return new Promise(resolve => {
    const options: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      cwd: directory,
      env: { ...scrubbedParentEnv(), HOME: directory, TMPDIR: '/tmp' },
    }
    const child = spawn(confined[0]!, confined.slice(1), options)
    let stdout = '',
      stderr = '',
      size = 0,
      failure: string | undefined
    const kill = () => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    const stop = (reason: string) => {
      failure ??= reason
      kill()
    }
    const abort = () => stop('process-execution-cancelled: ' + String(signal!.reason))
    const timer = setTimeout(() => stop('process-execution-timeout: exceeded 60000ms'), 60_000)
    signal?.addEventListener('abort', abort, { once: true })
    for (const [stream, append] of [
      [
        child.stdout!,
        (chunk: string) => {
          stdout += chunk
        },
      ],
      [
        child.stderr!,
        (chunk: string) => {
          stderr += chunk
        },
      ],
    ] as const) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        append(chunk)
        size += Buffer.byteLength(chunk)
        if (size > 32 * 1024 * 1024) stop('process-execution-output-limit: exceeded 32MiB')
      })
    }
    child.on('error', error => {
      failure ??= 'process-execution-failed: ' + error.message
    })
    child.on('exit', kill)
    child.on('close', (code, termination) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (termination !== null) failure ??= `process-execution-failed: signal ${termination}`
      resolve({ exitCode: code, stdout, stderr, ...(failure === undefined ? {} : { failure }) })
    })
  })
}

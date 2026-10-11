import { spawn, type SpawnOptions } from 'node:child_process'
import type { VerifierInvocation } from '../../src/verifier/command.ts'

export function spawnProcess(invocation: VerifierInvocation, signal?: AbortSignal): Promise<{
  exitCode: number | null; stdout: string; stderr: string; failure?: string
}> {
  signal?.throwIfAborted()
  return new Promise(resolve => {
    const options: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'], detached: true }
    const child = invocation.shell
      ? spawn(invocation.command, { ...options, shell: true })
      : spawn(invocation.argv[0], invocation.argv.slice(1), options)
    let stdout = '', stderr = '', size = 0, failure: string | undefined
    const kill = () => {
      if (child.pid === undefined) return
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    const stop = (reason: string) => { failure ??= reason; kill() }
    const abort = () => stop('process-execution-cancelled: ' + String(signal!.reason))
    const timer = setTimeout(() => stop('process-execution-timeout: exceeded 60000ms'), 60_000)
    signal?.addEventListener('abort', abort, { once: true })
    for (const [stream, append] of [
      [child.stdout!, (chunk: string) => { stdout += chunk }],
      [child.stderr!, (chunk: string) => { stderr += chunk }],
    ] as const) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        append(chunk)
        size += Buffer.byteLength(chunk)
        if (size > 32 * 1024 * 1024) stop('process-execution-output-limit: exceeded 32MiB')
      })
    }
    child.on('error', error => { failure ??= 'process-execution-failed: ' + error.message })
    child.on('exit', kill)
    child.on('close', (code, termination) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (code !== 0) failure ??= `process-execution-failed: exited ${code}, signal ${termination}`
      resolve({ exitCode: failure === undefined || code !== 0 ? code : null, stdout, stderr, ...(failure === undefined ? {} : { failure }) })
    })
  })
}

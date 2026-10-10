#!/usr/bin/env node
/**
 * The verifier command CLI: the runner in `src/verifier/command.ts` plus the one thing it may not do.
 *
 * The runner decides everything — the request's shape, whether the command is a shell line or an
 * argv, the verdict from the exit code, and the digests of what is on disk after the run — but no
 * module under `src/` may name a process executor, because a general executor runs whatever a string
 * says. So this file is the execution port: it spawns what the runner decided, and prints the
 * judgement.
 *
 * Its stdout is the contract every probe and `tests/verifier-command.spec.ts` read: one line of JSON
 * (`verdict`, `artifactDigest`, `inputDigests`, `detail`) followed by the `verifier-command: OK`
 * marker. Its exit code distinguishes the two outcomes that matter: **0** when a judgement was
 * formed — including a `fail` verdict, which is a successful judgement — and **2** when none could
 * be, with the reason on stderr and nothing on stdout. An empty digest on stdout would be an empty
 * success, which is the outcome this whole path exists to refuse.
 */

import { spawn } from 'node:child_process'

import { runVerifierCommand } from '../src/verifier/command.ts'

const OK = 'verifier-command: OK'
/** The child's streams: stdout belongs to nobody here, stderr is the reader's account of a failure. */
const STDIO = ['ignore', 'ignore', 'pipe']

/**
 * The real execution port.
 *
 * A shell line is handed to the shell; an argv is spawned directly, so its arguments are arguments.
 * A process that cannot be started at all resolves with `exitCode: null` and the reason — the runner
 * turns that into a `fail`, which is the fail-closed reading.
 */
function spawnProcess(invocation) {
  return new Promise(resolve => {
    const child = invocation.shell
      ? spawn(invocation.command, { shell: true, stdio: STDIO })
      : spawn(invocation.argv[0], invocation.argv.slice(1), { stdio: STDIO })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', error => resolve({ exitCode: null, stderr, failure: error.message }))
    child.on('close', code => resolve({ exitCode: code, stderr }))
  })
}

/** The request from argv[2] if it is there, otherwise from stdin. */
async function readRequest() {
  const inline = process.argv[2]
  if (inline !== undefined) return JSON.parse(inline)
  process.stdin.setEncoding('utf8')
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  if (raw.trim() === '') throw new Error('no request: pass the JSON on argv[2] or on stdin')
  return JSON.parse(raw)
}

try {
  const result = await runVerifierCommand(await readRequest(), spawnProcess)
  console.log(JSON.stringify(result))
  console.log(OK)
} catch (error) {
  console.error(`verifier-command: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}

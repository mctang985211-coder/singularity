#!/usr/bin/env node

import { spawn } from 'node:child_process'

import { runVerifierCommand } from '../src/verifier/command.ts'

const OK = 'verifier-command: OK'
const STDIO = ['ignore', 'ignore', 'pipe']

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

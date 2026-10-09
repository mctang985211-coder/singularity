#!/usr/bin/env node
/**
 * The real verifier execution adapter: run one command, read its exit code, pin the artifact and
 * the inputs.
 *
 * This is the deployment-side half of the verifier split. `src/verifier/implementation.ts` holds
 * the pure interface, the declaration gate and the selftest and executes nothing. Here the judge
 * is real: `node:child_process` runs the command with a shell, the exit code is the verdict, and
 * the artifact's bytes are hashed **after** the command ran, so the digest names what the verdict
 * was actually formed on. Every declared input is read from the path it names and hashed too, so a
 * caller receives the digest of the bytes that are there now, not a digest it declared earlier.
 *
 * The adapter reports; it does not adjudicate the bubble's claim. `inputDigests` carries the real
 * digests beside the declared ones in the detail, and refusing a mismatch belongs to the
 * production path (`src/verifier/production.ts`), which reads the same bytes itself. A sensor that
 * silently corrected its own input would hide exactly the tampering this exists to expose.
 *
 * Why an adapter and not a library function: execution is the one thing that may not be replayed.
 * A fold that ran a command would make a log's meaning depend on today's machine. So the process
 * lives outside `src/`, one command per judgement, and the caller records the result.
 *
 * The request is `{ command, artifactPath, inputs: [{ name, digest, path }] }`, on argv[2] or on
 * stdin, where `path` is the absolute path of the input's bytes and `digest` is what the binding
 * declared. A declaration with no path names no bytes and cannot be hashed; an input is read, not
 * trusted.
 *
 * Usage:
 *   node scripts/verifier-command.mjs '{"command":"…","artifactPath":"…","inputs":[]}'
 *   printf '%s' "$request" | node scripts/verifier-command.mjs
 *
 * It prints one JSON object — `{ verdict, artifactDigest, inputDigests, detail }` — then the line
 * `verifier-command: OK`. The judged command's own output is captured, never inherited, so it
 * cannot be mistaken for this script's answer. The exit code is non-zero **only** when this
 * script itself could not judge at all: a non-zero exit from the judged command is a verdict
 * (`fail`), which is a successful judgement, not a failure of the adapter.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const REQUEST_MEMBERS = ['command', 'artifactPath', 'inputs']
const OK = 'verifier-command: OK'

/** Read the request from argv[2] if it is there, otherwise from stdin. */
async function readRequest() {
  const inline = process.argv[2]
  if (inline !== undefined) return JSON.parse(inline)
  process.stdin.setEncoding('utf8')
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  if (raw.trim() === '') throw new Error('no request: pass the JSON on argv[2] or on stdin')
  return JSON.parse(raw)
}

function asRecord(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${field} must be an object, got ${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value}`)
  return value
}

function text(source, key, field) {
  const value = source[key]
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${field} must be a non-empty string, got ${value === null ? 'null' : typeof value}`)
  return value
}

/**
 * The declared inputs, closed and read literally: an absent member stays absent, not invented.
 *
 * `path` is required, because an input nobody can read is a claim with no bytes behind it, and
 * hashing a declaration would only return the declaration.
 */
function readInputs(raw) {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw new Error('request.inputs must be an array of {name, digest, path}')
  return raw.map((entry, index) => {
    const where = `request.inputs[${index}]`
    const input = asRecord(entry, where)
    for (const key of Object.keys(input))
      if (key !== 'name' && key !== 'digest' && key !== 'path') throw new Error(`${where} carries undeclared member "${key}"`)
    const path = text(input, 'path', `${where}.path`)
    if (!isAbsolute(path)) throw new Error(`${where}.path must be an absolute path, got ${JSON.stringify(path)}; the adapter reads bytes, not names`)
    return { name: text(input, 'name', `${where}.name`), digest: text(input, 'digest', `${where}.digest`), path }
  })
}

/** Run the command for real, with a shell, and collect its streams instead of inheriting them. */
function execute(command) {
  return new Promise(resolve => {
    const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const outcome = { exitCode: null, stdout: '', stderr: '', spawnError: null }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      outcome.stdout += chunk
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => {
      outcome.stderr += chunk
    })
    // A command the shell cannot even start is never a pass: `fail` is the fail-closed reading,
    // and the reason travels in the detail. (The shell usually reports 127 instead, which is
    // already a non-zero exit.)
    child.on('error', error => {
      outcome.spawnError = error
      resolve(outcome)
    })
    child.on('close', code => {
      outcome.exitCode = code
      resolve(outcome)
    })
  })
}

/** The real content digest of the artifact's bytes, taken after the command has run. */
async function digestOfFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** The real content digest of every input's bytes, in the order the inputs were declared. */
async function hashInputs(inputs) {
  const digests = []
  for (const input of inputs) digests.push({ name: input.name, digest: await digestOfFile(input.path) })
  return digests
}

/** One line, bounded: a detail a receipt can carry without becoming a log of its own. */
function clip(value) {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 240 ? oneLine : `…${oneLine.slice(-240)}`
}

/** What the reader needs to see why this verdict is this verdict. */
function describe(command, outcome, inputs) {
  const declared = inputs.length === 0 ? 'no declared inputs' : `declared inputs ${inputs.map(input => `${input.name}=${input.digest.slice(0, 12)}…`).join(', ')}`
  const where =
    outcome.exitCode === null
      ? `did not run${outcome.spawnError === null ? '' : ` (${outcome.spawnError.message})`}`
      : `exited ${outcome.exitCode}`
  const noise = outcome.stderr.trim() === '' ? '' : `; stderr: ${clip(outcome.stderr)}`
  return `"${command}" ${where}; ${declared}${noise}`
}

async function main() {
  const request = asRecord(await readRequest(), 'request')
  for (const key of Object.keys(request))
    if (!REQUEST_MEMBERS.includes(key)) throw new Error(`request carries undeclared member "${key}"`)

  const command = text(request, 'command', 'request.command')
  const artifactPath = text(request, 'artifactPath', 'request.artifactPath')
  const inputs = readInputs(request['inputs'])

  const outcome = await execute(command)
  const artifactDigest = await digestOfFile(artifactPath)
  // The inputs are read after the command, exactly as the artifact is: these are the bytes that
  // were there when the judgement was formed, and the detail shows what was declared against them.
  const inputDigests = await hashInputs(inputs)
  const verdict = outcome.exitCode === 0 ? 'pass' : 'fail'

  console.log(JSON.stringify({ verdict, artifactDigest, inputDigests, detail: describe(command, outcome, inputs) }))
  console.log(OK)
}

try {
  await main()
} catch (error) {
  // Its own error, not a verdict: nothing is printed to stdout, and the exit code says so.
  console.error(`verifier-command: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}

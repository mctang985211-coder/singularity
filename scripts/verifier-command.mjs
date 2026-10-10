#!/usr/bin/env node
/**
 * The real verifier execution adapter: run one command, read its exit code, pin the artifact and
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

#!/usr/bin/env node
/**
 * The real measurement adapter: run one measurement program, read its number, and pin the bytes.
 *
 * This is the deployment-side half of the measurement split. `src/measure/execution.ts` holds the
 * pure path — resolve the implementation by content digest, run its selftest, hash the inputs,
 * accept the number only from the metric's implementation — and executes nothing. Here the program
 * is real: `node:child_process` runs it with a shell, and the artifact's bytes are hashed **after**
 * it ran, so the digest names what the number was actually formed on. Every declared input is read
 * from the path it names and hashed too, so a caller receives the digest of the bytes that are
 * there now rather than a digest it declared earlier.
 *
 * **The number.** The program prints its report as the last non-empty line of stdout: one JSON
 * object `{ quality, cost? }`. An absent `cost` means the program did not observe one, and it stays
 * absent in this adapter's answer — a missing cost that arrived as `0` would enter the cost rule as
 * a real measurement. Anything else the program prints is captured into the detail, so a program
 * may log freely.
 *
 * **A program that produced no number is a miss, not a failure of this adapter.** A non-zero exit,
 * or a command the shell cannot start, is reported as `{ missed: <reason> }` and this script still
 * exits 0: the attempt happened, and "it produced nothing" is its outcome. The caller records it as
 * `trial/missed`, which keeps the plan's slot named and the denominator intact. Reporting a zero
 * instead would be inventing a measurement nobody made.
 *
 * The request is `{ command, artifactPath, inputs: [{ name, digest, path }] }`, on argv[2] or on
 * stdin, where `path` is the absolute path of the input's bytes and `digest` is what the binding
 * declared. A declaration with no path names no bytes and cannot be hashed; an input is read, not
 * trusted.
 *
 * Usage:
 *   node scripts/measure-runner.mjs '{"command":"…","artifactPath":"…","inputs":[]}'
 *   printf '%s' "$request" | node scripts/measure-runner.mjs
 *
 * It prints one JSON object — `{ quality, cost?, artifactDigest, inputDigests, detail }` or
 * `{ missed, detail }` — then the line `measure-runner: OK`. The measured command's own output is
 * captured, never inherited, so it cannot be mistaken for this script's answer. The exit code is
 * non-zero **only** when this script could not measure at all: an unreadable artifact, an input
 * that names no bytes, or a program that exited 0 without printing a number.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const REQUEST_MEMBERS = ['command', 'artifactPath', 'inputs']
const NUMBER_MEMBERS = ['quality', 'cost']
const OK = 'measure-runner: OK'

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

/** A number a report may carry: not `NaN`, not `Infinity`, and not a numeric string. */
function finiteNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${field} must be a finite number, got ${String(value)}`)
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

/** Run the program for real, with a shell, and collect its streams instead of inheriting them. */
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
    // A command the shell cannot even start produced no number, so it is a miss like any other:
    // fail-closed, and the reason travels in the report. (The shell usually reports 127 instead.)
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

/** The real content digest of the artifact's bytes, taken after the program has run. */
async function digestOfFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** The real content digest of every input's bytes, in the order the inputs were declared. */
async function hashInputs(inputs) {
  const digests = []
  for (const input of inputs) digests.push({ name: input.name, digest: await digestOfFile(input.path) })
  return digests
}

/** One line, bounded: a detail a report can carry without becoming a log of its own. */
function clip(value) {
  const oneLine = value.replace(/\s+/g, ' ').trim()
  return oneLine.length <= 240 ? oneLine : `…${oneLine.slice(-240)}`
}

/** The number the program printed, or this adapter's own refusal: a program that exits 0 with no number is broken, not missable. */
function readNumber(stdout, command) {
  const lines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const last = lines.at(-1)
  if (last === undefined)
    throw new Error(`"${command}" exited 0 without printing a number; a measurement is one JSON line {quality, cost?} as the last line of stdout`)
  let parsed
  try {
    parsed = JSON.parse(last)
  } catch (error) {
    throw new Error(`the last stdout line of "${command}" is not JSON (${error instanceof Error ? error.message : String(error)}): ${clip(last)}`)
  }
  const report = asRecord(parsed, 'the measurement line')
  for (const key of Object.keys(report))
    if (!NUMBER_MEMBERS.includes(key)) throw new Error(`the measurement line carries undeclared member "${key}"; it is {quality, cost?}`)
  const quality = finiteNumber(report['quality'], 'the measurement line.quality')
  const cost = report['cost'] === undefined ? undefined : finiteNumber(report['cost'], 'the measurement line.cost')
  return { quality, cost }
}

/** What the reader needs to see why this is the number it is. */
function describe(command, outcome, inputs, measured) {
  const declared = inputs.length === 0 ? 'no declared inputs' : `declared inputs ${inputs.map(input => `${input.name}=${input.digest.slice(0, 12)}…`).join(', ')}`
  const where =
    outcome.exitCode === null
      ? `did not run${outcome.spawnError === null ? '' : ` (${outcome.spawnError.message})`}`
      : `exited ${outcome.exitCode}`
  const number =
    measured === undefined
      ? 'produced no number'
      : `measured quality ${String(measured.quality)}${measured.cost === undefined ? ' with no cost reported' : ` at cost ${String(measured.cost)}`}`
  const noise = outcome.stderr.trim() === '' ? '' : `; stderr: ${clip(outcome.stderr)}`
  return `"${command}" ${where} and ${number}; ${declared}${noise}`
}

async function main() {
  const request = asRecord(await readRequest(), 'request')
  for (const key of Object.keys(request))
    if (!REQUEST_MEMBERS.includes(key)) throw new Error(`request carries undeclared member "${key}"`)

  const command = text(request, 'command', 'request.command')
  const artifactPath = text(request, 'artifactPath', 'request.artifactPath')
  const inputs = readInputs(request['inputs'])

  const outcome = await execute(command)
  if (outcome.exitCode !== 0 || outcome.spawnError !== null) {
    // No number: a miss, reported as an outcome. Nothing is hashed, because a miss names no artifact.
    console.log(JSON.stringify({ missed: describe(command, outcome, inputs, undefined) }))
    console.log(OK)
    return
  }

  const measured = readNumber(outcome.stdout, command)
  const artifactDigest = await digestOfFile(artifactPath)
  // The inputs are read after the program, exactly as the artifact is: these are the bytes that were
  // there when the number was formed, and the detail shows what was declared against them.
  const inputDigests = await hashInputs(inputs)

  console.log(
    JSON.stringify({
      quality: measured.quality,
      ...(measured.cost === undefined ? {} : { cost: measured.cost }),
      artifactDigest,
      inputDigests,
      detail: describe(command, outcome, inputs, measured),
    }),
  )
  console.log(OK)
}

try {
  await main()
} catch (error) {
  // Its own error, not a measurement: nothing is printed to stdout, and the exit code says so.
  console.error(`measure-runner: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 2
}

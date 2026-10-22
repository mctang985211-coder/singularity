#!/usr/bin/env node
/**
 * The letters criterion's own implementation: the program whose exit code is the verdict.
 *
 * It is deployment material, not source: the criterion pins the digest of these bytes, and a
 * different build at the same `ref@version` is what that digest catches. It judges one claim —
 * that the report is the number of ASCII letters in the input — and it cannot be made to pass by
 * writing a number that is merely plausible.
 *
 * Usage: node verifier.mjs <artifact> <input>
 * Exit 0 = pass, non-zero = fail, 2 = the invocation itself was wrong (not a verdict).
 */

import { readFileSync } from 'node:fs'

const [artifactPath, inputPath] = process.argv.slice(2)
if (artifactPath === undefined || inputPath === undefined) {
  console.error('letters verifier: usage: verifier.mjs <artifact> <input>')
  process.exit(2)
}

// A report is a decimal count and nothing else. An empty artifact — what a crashed program leaves
// behind — is not a claim of zero, so it fails on every input, including a letter-free one.
const report = readFileSync(artifactPath, 'utf8').trim()
if (!/^[0-9]+$/.test(report)) {
  console.error(`the report is not a decimal count: ${JSON.stringify(report.slice(0, 40))}`)
  process.exit(1)
}

const claimed = Number(report)
const letters = (readFileSync(inputPath, 'utf8').match(/[A-Za-z]/g) ?? []).length
if (claimed !== letters) {
  console.error(`the report claims ${claimed} letters; the input holds ${letters}`)
  process.exit(1)
}

console.log(`letters ${letters}`)

#!/usr/bin/env node
/**
 * Differential harness for the RRSI decision-layer port (google-research/rrsi @ be50316, Apache-2.0).
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { noveltyOf, select } = await import(pathToFileURL(join(ROOT, 'src/strategy/decision.ts')).href)

const corpus = JSON.parse(readFileSync(join(ROOT, 'tests/vectors/strategy-decision-vectors.json'), 'utf8'))
const ledger = readFileSync(join(ROOT, 'docs/divergence-ledger.md'), 'utf8')

function scenarioOf(vector) {
  const defaults = corpus.defaults
  const input = vector.input
  const candidates = input.candidates.map(raw => ({
    ...defaults.candidate,
    ...raw,
    measurement: raw.measurement === null ? null : { ...defaults.measurement, ...raw.measurement },
  }))
  return {
    calibration: { ...defaults.calibration, ...(input.calibration ?? {}) },
    weights: { ...defaults.weights, ...(input.weights ?? {}) },
    history: { acceptedAssets: [], deltas: [], ...(input.history ?? {}) },
    candidates,
    upstream: { acceptedCounts: {}, ...defaults.upstream, ...(input.upstream ?? {}) },
  }
}

function shapeOf(selection, outcomes) {
  return { winner: selection.winner, admitted: outcomes.map(outcome => outcome.admitted) }
}

// ---------------------------------------------------------------------------------------------
// Per-function comparison
// ---------------------------------------------------------------------------------------------

const failures = []
const notes = []

function fail(id, detail) {
  failures.push(`${id}: ${detail}`)
}

function canonical(value) {
  return JSON.stringify(value, (key, entry) =>
    entry === null || typeof entry !== 'object' || Array.isArray(entry)
      ? entry
      : Object.fromEntries(Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : 1))),
  )
}

/** The comparable part of a vector's expectation: `reasonIncludes` is checked as a substring set. */
function expectationOf(expected) {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) return expected
  return { winner: expected.winner, admitted: expected.admitted }
}

const references = Object.fromEntries(
  corpus.vectors.map(vector => {
    if (vector.upstream?.value === undefined) throw new Error('Missing frozen upstream outcome: ' + vector.id)
    return [vector.id, vector.upstream.value]
  }),
)

function compareNovelty(vector) {
  return {
    actual: noveltyOf(vector.input.assets ?? [], { acceptedAssets: vector.input.acceptedAssets ?? [], deltas: [] }),
    reference: references[vector.id],
  }
}

function compareSelect(vector) {
  const plan = scenarioOf(vector)
  const selection = select(plan.candidates, plan.history, plan.calibration, plan.weights)
  const outcomes = [...selection.outcomes].sort((left, right) => left.slot - right.slot)
  const reasons = Object.fromEntries(outcomes.map(outcome => [String(outcome.slot), outcome.reason]))
  // The two sides must be looking at the same round: the incumbent implied by a slot's measurement
  // and its frozen gain has to be the incumbent the upstream side is given. `frozenOverride` marks
  // the vectors that break that on purpose (the R03 re-derived head), and a missing gain has
  // nothing to check.
  if (vector.frozenOverride !== true) {
    for (const candidate of plan.candidates) {
      const delta = plan.history.deltas.find(entry => entry.slot === candidate.slot)
      if (candidate.measurement === null || delta === undefined) continue
      const implied = candidate.measurement.quality - delta.deltaQuality
      if (Math.abs(implied - plan.upstream.incumbentQuality) > 1e-9) {
        fail(
          vector.id,
          `slot ${candidate.slot} implies incumbent ${implied}, but the upstream side is given ${plan.upstream.incumbentQuality}`,
        )
      }
    }
  }
  return {
    actual: shapeOf(selection, outcomes),
    reference: references[vector.id],
    reasons,
  }
}

const COMPARISONS = { noveltyOf: compareNovelty, select: compareSelect }

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

const tagCounts = {}
const functionCounts = {}
let agreements = 0
let divergences = 0

for (const vector of corpus.vectors) {
  const compare = COMPARISONS[vector.function]
  if (compare === undefined) {
    fail(vector.id, `no comparison for function ${vector.function}`)
    continue
  }
  tagCounts[vector.kind] = (tagCounts[vector.kind] ?? 0) + 1
  functionCounts[vector.function] = (functionCounts[vector.function] ?? 0) + 1
  const { actual, reference, reasons } = compare(vector)

  if (canonical(actual) !== canonical(expectationOf(vector.expected))) {
    fail(vector.id, `port answered ${canonical(actual)}, corpus expects ${canonical(expectationOf(vector.expected))}`)
  }
  for (const [slot, needle] of Object.entries(vector.expected.reasonIncludes ?? {})) {
    const reason = reasons?.[slot]
    if (reason === undefined || !reason.includes(needle)) {
      fail(vector.id, `slot ${slot} reason does not contain "${needle}": ${reason ?? '(no reason)'}`)
    }
  }
  const agreed = canonical(actual) === canonical(reference)
  if (agreed) agreements += 1
  else divergences += 1
  if (vector.kind === 'deterministic' || vector.kind === 'upstream-native') {
    if (!agreed)
      fail(
        vector.id,
        `tagged ${vector.kind} but the port and upstream disagree: port ${canonical(actual)} vs upstream ${canonical(reference)}`,
      )
  } else if (vector.kind === 'port-adapted') {
    if (!ledger.includes(`\`${vector.id}\``))
      fail(vector.id, 'tagged port-adapted but docs/divergence-ledger.md has no row naming it')
    if (agreed)
      fail(vector.id, `tagged port-adapted but both sides agree (${canonical(actual)}); the tag or the input is wrong`)
  } else {
    fail(vector.id, `unknown tag ${vector.kind}`)
  }
}

const unexplained = divergences - corpus.vectors.filter(vector => vector.kind === 'port-adapted').length
if (unexplained > 0) fail('corpus', `${unexplained} divergence(s) come from vectors that are not tagged port-adapted`)
notes.push(
  `functions: ${Object.entries(functionCounts)
    .map(([name, count]) => `${count} ${name}`)
    .join(', ')}`,
)
notes.push(
  `tags: ${Object.entries(tagCounts)
    .map(([tag, count]) => `${count} ${tag}`)
    .join(', ')}`,
)
notes.push(`agreement with frozen RRSI outcomes: ${agreements} agree, ${divergences} diverge`)
notes.push(`frozen reference coverage: ${Object.keys(references).length} vector(s)`)

if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  console.log(`strategy-vectors: FAILED (${failures.length} finding(s))`)
  process.exit(1)
}
for (const note of notes) console.log(`  ${note}`)
console.log(
  `strategy-vectors: OK (${corpus.vectors.length} vectors, ${divergences} divergence(s) all explained in docs/divergence-ledger.md)`,
)

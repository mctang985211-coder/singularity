#!/usr/bin/env node
/**
 * Differential harness for the RRSI decision-layer port (google-research/rrsi @ be50316, Apache-2.0).
 *
 * It puts the upstream rules and `src/strategy/decision.ts` on the same synthetic inputs and reports
 * agreement or divergence. Three things are checked, and each of them can fail on its own:
 *
 * 1. **The corpus is not trusted, it is checked.** Every vector's `expected` value must equal what
 *    the port actually answers, and its `reasonIncludes` substrings must appear in the port's reason
 *    strings. A hand-written expectation that the code contradicts fails here.
 * 2. **The upstream transcription is not trusted either.** The Python is never invoked — upstream is
 *    a specification, not a runtime dependency — so the upstream side is a transcription whose line
 *    numbers are cited at every function. Every vector that carries an `upstream.value` (measured by
 *    running the real checkout once, at extraction time) must be reproduced by the transcription.
 * 3. **Divergence is only allowed where the ledger says so.** `deterministic` and `upstream-native`
 *    vectors must agree with upstream; a `port-adapted` vector must differ, and its id must appear in
 *    `docs/divergence-ledger.md`. An unexplained divergence is a bug; an explained one is a decision.
 *
 * Prints `strategy-vectors: OK` on success. Wire it to a gate as a probe: it is the only check that
 * can see a port that is self-consistently wrong.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { editBudgetFor, noveltyOf, select } = await import(pathToFileURL(join(ROOT, 'src/strategy/decision.ts')).href)

const corpus = JSON.parse(readFileSync(join(ROOT, 'tests/vectors/strategy-decision-vectors.json'), 'utf8'))
const ledger = readFileSync(join(ROOT, 'docs/divergence-ledger.md'), 'utf8')
const VOCABULARY = Object.fromEntries(Object.entries(corpus.vocabulary).filter(([key]) => key !== 'note'))

// ---------------------------------------------------------------------------------------------
// The upstream side: a transcription, never a call.
// ---------------------------------------------------------------------------------------------

const UPSTREAM_K = ['prompt', 'control_flow', 'config', 'output_plumbing', 'context_mgmt', 'client_tool', 'skill', 'memory', 'subagent']
const UPSTREAM_K_STR = ['client_tool', 'skill', 'memory', 'subagent']
const UPSTREAM_CFG = { beta0: 0.10, beta1: 40, w_s: 100, w_c: 15, w_n: 0.5 }

/** rrsi/schedule.py:43-50. `t` is 0-based and the denominator is `T`, not `T - 1`. */
function upstreamEditBudget(t, rounds, minimum, first) {
  if (rounds <= 0) return first
  const step = Math.max(0, Math.min(Math.trunc(t), Math.trunc(rounds)))
  const value = minimum + (first - minimum) * 0.5 * (1 + Math.cos((Math.PI * step) / rounds))
  return Math.ceil(Number(value.toFixed(9)))
}

/** rrsi/components.py:103-108. `set()` deduplicates, and only K_STR classes count. */
function upstreamNovelty(components, counts) {
  return [...new Set(components)].filter((component) => UPSTREAM_K_STR.includes(component) && (counts[component] ?? 0) === 0).length
}

const UPSTREAM_SIGNALS = [
  ['memory', [/\bMemory\(/, /\.remember\(/, /\.recall\(/, /_STATE_DIR/]],
  ['skill', [/skills\//, /SkillRegistry/, /skill_use/, /skill_catalog/, /upload_skills/]],
  ['client_tool', [/ToolRegistry/, /register_tool/, /tool_spec/, /CLIENT_TOOLS/]],
  ['subagent', [/\bsubcall\(/, /sub_agent/, /subagent/]],
]
const UPSTREAM_STRING_LINE = /^[+-]\s*(?:[frb]?["']|""")/

/** rrsi/components.py:61-69. */
function upstreamTextOnly(diff) {
  const changed = diff.split('\n').filter((line) =>
    (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---') && line.slice(1).trim())
  if (changed.length === 0) return false
  return changed.every((line) => UPSTREAM_STRING_LINE.test(line) || line.slice(1).trimStart().startsWith('#'))
}

/** rrsi/components.py:72-79. */
function upstreamClassifyDiff(diff) {
  if (upstreamTextOnly(diff)) return 'prompt'
  for (const [component, patterns] of UPSTREAM_SIGNALS) if (patterns.some((pattern) => pattern.test(diff))) return component
  return 'prompt'
}

/** rrsi/components.py:82-100: a declared tag survives only with diff evidence, else the diff decides. */
function upstreamNormalize(declared, diff) {
  const tag = (declared ?? '').trim().toLowerCase()
  const evidence = UPSTREAM_SIGNALS.some(([component, patterns]) => component === tag && patterns.some((pattern) => pattern.test(diff)))
  return UPSTREAM_K.includes(tag) && evidence ? tag : upstreamClassifyDiff(diff)
}

/** rrsi/evaluate.py:131-135: 0.0 whenever either side has no token count. */
function upstreamRelativeCostChange(candidateCost, incumbentCost) {
  if (!candidateCost || !incumbentCost) return 0.0
  return (candidateCost - incumbentCost) / incumbentCost
}

/** rrsi/selection.py:81-94. */
function upstreamCostRule(deltaS, deltaC, novelty, delta, cfg) {
  if (deltaS > delta) return deltaC <= cfg.beta0 + cfg.beta1 * deltaS
  return cfg.w_s * deltaS - cfg.w_c * deltaC + cfg.w_n * novelty > 0
}

/**
 * rrsi/selection.py:97-121 (`judge`: gate failure, then the S* floor, then the cost rule, then the
 * domain guards) and :124-137 (`select_round`: argmax of S' over the admissible set, `max` keeping
 * the first of equal scores).
 */
function upstreamSelect(plan) {
  const cfg = { ...UPSTREAM_CFG, w_s: plan.weights.quality, w_c: plan.weights.cost }
  const decisions = plan.candidates.map((candidate) => {
    const delta = plan.history.deltas.find((entry) => entry.slot === candidate.slot)
    if (candidate.inadmissible !== null) return { slot: candidate.slot, admissible: false, quality: null }
    if (candidate.measurement === null || delta === undefined) return { slot: candidate.slot, admissible: false, quality: null }
    const quality = plan.upstream.incumbentQuality + delta.deltaQuality
    const cost = delta.deltaCost === null ? null : plan.upstream.incumbentCost * (1 + delta.deltaCost)
    const novelty = upstreamNovelty(upstreamComponentsOf(candidate, plan), plan.upstream.acceptedCounts)
    const relative = upstreamRelativeCostChange(cost, plan.upstream.incumbentCost)
    let admissible = quality >= plan.upstream.sStar - plan.upstream.delta
    if (admissible) admissible = upstreamCostRule(delta.deltaQuality, relative, novelty, plan.upstream.delta, cfg)
    if (admissible) admissible = candidate.constraintsMet
    return { slot: candidate.slot, admissible, quality }
  })
  let winner = null
  let best = Number.NEGATIVE_INFINITY
  for (const decision of decisions) {
    if (!decision.admissible || decision.quality === null) continue
    if (decision.quality > best) {
      best = decision.quality
      winner = decision.slot
    }
  }
  return { winner, admitted: decisions.map((decision) => decision.admissible) }
}

// ---------------------------------------------------------------------------------------------
// Shared scenario building: both sides read the same synthetic numbers.
// ---------------------------------------------------------------------------------------------

function upstreamComponentsOf(candidate, plan) {
  const override = plan.upstream.components?.[String(candidate.slot)]
  if (override !== undefined) return override
  return (candidate.assets ?? []).map((asset) => VOCABULARY[asset] ?? asset)
}

function countsOf(acceptedAssets) {
  const counts = {}
  for (const asset of acceptedAssets ?? []) {
    const component = VOCABULARY[asset] ?? asset
    counts[component] = (counts[component] ?? 0) + 1
  }
  return counts
}

function scenarioOf(vector) {
  const defaults = corpus.defaults
  const input = vector.input
  const candidates = input.candidates.map((raw) => ({
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
  return { winner: selection.winner, admitted: outcomes.map((outcome) => outcome.admitted) }
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
      : Object.fromEntries(Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : 1))))
}

/** The comparable part of a vector's expectation: `reasonIncludes` is checked as a substring set. */
function expectationOf(expected) {
  if (expected === null || typeof expected !== 'object' || Array.isArray(expected)) return expected
  return { winner: expected.winner, admitted: expected.admitted }
}

function compareEditBudget(vector) {
  const input = vector.input
  const port = (round) => editBudgetFor(round, input.rounds, input.first, input.minimum)
  const upstream = (round) => upstreamEditBudget(round - 1, input.rounds, input.minimum, input.first)
  if (input.roundsToCheck === undefined) return { actual: port(input.round), reference: upstream(input.round) }
  return { actual: input.roundsToCheck.map(port), reference: input.roundsToCheck.map(upstream) }
}

function compareNovelty(vector) {
  const input = vector.input
  const history = { acceptedAssets: input.acceptedAssets ?? [], deltas: [] }
  const components = input.upstreamNormalize === undefined
    ? (input.assets ?? []).map((asset) => VOCABULARY[asset] ?? asset)
    : [upstreamNormalize(input.upstreamNormalize.declared, input.upstreamNormalize.diff)]
  return {
    actual: noveltyOf(input.assets ?? [], history),
    reference: upstreamNovelty(components, countsOf(input.acceptedAssets)),
  }
}

function compareSelect(vector) {
  const plan = scenarioOf(vector)
  const selection = select(plan.candidates, plan.history, plan.calibration, plan.weights)
  const outcomes = [...selection.outcomes].sort((left, right) => left.slot - right.slot)
  const reasons = Object.fromEntries(outcomes.map((outcome) => [String(outcome.slot), outcome.reason]))
  // The two sides must be looking at the same round: the incumbent implied by a slot's measurement
  // and its frozen gain has to be the incumbent the upstream side is given. `frozenOverride` marks
  // the vectors that break that on purpose (the R03 re-derived head), and a missing gain has
  // nothing to check.
  if (vector.frozenOverride !== true) {
    for (const candidate of plan.candidates) {
      const delta = plan.history.deltas.find((entry) => entry.slot === candidate.slot)
      if (candidate.measurement === null || delta === undefined) continue
      const implied = candidate.measurement.quality - delta.deltaQuality
      if (Math.abs(implied - plan.upstream.incumbentQuality) > 1e-9) {
        fail(vector.id, `slot ${candidate.slot} implies incumbent ${implied}, but the upstream side is given ${plan.upstream.incumbentQuality}`)
      }
    }
  }
  return {
    actual: shapeOf(selection, outcomes),
    reference: upstreamSelect(plan),
    reasons,
  }
}

const COMPARISONS = { editBudgetFor: compareEditBudget, noveltyOf: compareNovelty, select: compareSelect }

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

const tagCounts = {}
const functionCounts = {}
let agreements = 0
let divergences = 0
let transcribed = 0

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
  if (vector.upstream?.value !== undefined) {
    transcribed += 1
    if (canonical(reference) !== canonical(vector.upstream.value)) {
      fail(vector.id, `the upstream transcription answered ${canonical(reference)}, upstream measured ${canonical(vector.upstream.value)} (${vector.upstream.call})`)
    }
  }

  const agreed = canonical(actual) === canonical(reference)
  if (agreed) agreements += 1
  else divergences += 1
  if (vector.kind === 'deterministic' || vector.kind === 'upstream-native') {
    if (!agreed) fail(vector.id, `tagged ${vector.kind} but the port and upstream disagree: port ${canonical(actual)} vs upstream ${canonical(reference)}`)
  } else if (vector.kind === 'port-adapted') {
    if (!ledger.includes(`\`${vector.id}\``)) fail(vector.id, 'tagged port-adapted but docs/divergence-ledger.md has no row naming it')
    if (agreed) fail(vector.id, `tagged port-adapted but both sides agree (${canonical(actual)}); the tag or the input is wrong`)
  } else {
    fail(vector.id, `unknown tag ${vector.kind}`)
  }
}

const unexplained = divergences - corpus.vectors.filter((vector) => vector.kind === 'port-adapted').length
if (unexplained > 0) fail('corpus', `${unexplained} divergence(s) come from vectors that are not tagged port-adapted`)
notes.push(`functions: ${Object.entries(functionCounts).map(([name, count]) => `${count} ${name}`).join(', ')}`)
notes.push(`tags: ${Object.entries(tagCounts).map(([tag, count]) => `${count} ${tag}`).join(', ')}`)
notes.push(`agreement with the upstream transcription: ${agreements} agree, ${divergences} diverge`)
notes.push(`upstream transcription reproduced the measured python value on ${transcribed} vector(s)`)

if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAIL ${failure}`)
  console.log(`strategy-vectors: FAILED (${failures.length} finding(s))`)
  process.exit(1)
}
for (const note of notes) console.log(`  ${note}`)
console.log(`strategy-vectors: OK (${corpus.vectors.length} vectors, ${divergences} divergence(s) all explained in docs/divergence-ledger.md)`)

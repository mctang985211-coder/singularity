#!/usr/bin/env node
/**
 * C+D together: one real measurement campaign, two explicit rounds, and one controlled release —
 * in one process, over one real control store, with the native approval seam mounted.
 *
 * Each slice has its own probe (`measure-probe`, `round-probe`, `release-probe`). What none of them
 * can show is the seam between them, which is what this probe exists for:
 *
 *   1. **A round with m >= 2 candidates from one incumbent.** Round 1 opens three slots against one
 *      incumbent and decides them; every slot carries its own evaluation. Nothing here uses the
 *      round-probe's stand-in measurement table: the numbers come from `src/measure/**`.
 *   2. **Every report has real trials.** Each trial goes through the measure slice's own
 *      `runMeasurement`: the implementation is resolved by the digest of its bytes, its selftest runs
 *      in both directions, the declared inputs are hashed **before** the programs start, real
 *      processes run, and the artifact is hashed **after** they ran. Two programs run per trial: the
 *      fixed selector runtime applies the revision's declared method and writes the artifact, and the
 *      meter — the implementation the metric names — prints the number it computed from that
 *      artifact and the reference list. The number in the log is the one the meter printed; no
 *      quality is typed into a payload, and swapping the method bytes changes the number.
 *   3. **Missing denominators are correct.** One candidate plans `trials: 2`, produces one
 *      observation and one explicitly recorded miss: the aggregate reports `denominator 2`,
 *      `quality = observed/2` and names the empty slot (R06's measured defect).
 *   4. **A high score out of bounds is refused before any argmax.** One candidate scores *higher*
 *      than the winner and fails a hard constraint checked by its own program; it does not win, its
 *      outcome names the constraint, and the release path cannot publish it.
 *   5. **Round two reads round one** (R04). Round 2's incumbent is the revision round 1 published,
 *      its `historyCutoff` sits after round 1's facts, its novelty is counted against the assets
 *      round 1 published, its frozen gain is relative to round 1's incumbent — and replaying the
 *      same cutoff after later facts reproduces the same decision.
 *   6. **The release path is controlled.** The winner is drafted, approved through the real
 *      `ctx.approval` (the fact carries the `approval/asked` id of the ask that produced it), and the
 *      head moves by compare-and-swap. An unapproved revision is refused, a stale approval is
 *      refused, a switch whose `expected` head moved is refused, and re-folding every recorded fact
 *      from scratch reproduces the same head and the same selections.
 *
 * **What is observed, and what is not.** The answerer composed here is a listener on the
 * deployment's `approval/request` waterfall, which is what a UI answerer is, so what is observed is
 * the *seam plumbing*: the real service issues the audit pair and our fact carries that id. It is
 * **not** observed that a human decided anything — no UI answerer and no human are in this process,
 * and that stays unobserved rather than simulated. The same discipline applies to the numbers: the
 * measurement *path* is real end to end, but the method files the programs read are written by this
 * probe, so what is observed is "the number in the log is the one a spawned program computed from
 * the bytes the revision declared", not "a model improved".
 *
 * **Isolation and comparability at once.** Every evaluation is measured in a run of its own with its
 * own bubble, and what the two rounds pool under is the *context* digest of that bubble — the model,
 * the tool digests, the conditions and the declared inputs (`contextDigestOf`) — never the run's
 * identity.
 * So candidates measured in different runs, under bubbles declaring the same model, the same tool
 * implementations and the same conditions, are decided together in one round. The limit is real too:
 * a candidate whose bubble declares another model, or whose run used a rebuilt tool, is not pooled at
 * all — the round refuses with `caliber-mismatch` and names the two sides. What differs between
 * candidates is the revision under test, which its manifest content-addresses; what must not differ
 * is the apparatus around it.
 *
 * Run: node scripts/cd-probe.mjs
 *
 * @module singularity-core/scripts/cd-probe
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dshModule, openPersistence } from './dsh-control-runtime.mjs'
import { digestOf } from '../src/protocol/envelope.ts'
import { foldSubjects } from '../src/protocol/fold.ts'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import { ProtocolRefusal } from '../src/protocol/refusal.ts'
import { declareTaskProtocol, SCHEDULER_ROLE, TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, verifierRoleOf } from '../src/task/protocol.ts'
import { createMeasureCommands } from '../src/measure/commands.ts'
import { runMeasurement } from '../src/measure/execution.ts'
import { contextDigestOf, declareMeasureProtocol, MEASURE_PROTOCOL, MEASURE_VERSION } from '../src/measure/protocol.ts'
import { caliberDigestOf, projectEvaluation } from '../src/measure/view.ts'
import { createStrategyCommands } from '../src/strategy/commands.ts'
import { declareStrategyProtocol, sameRevision, STRATEGY_PROTOCOL, STRATEGY_ROLE, STRATEGY_VERSION } from '../src/strategy/protocol.ts'
import { projectRound } from '../src/strategy/view.ts'
import { APPROVER_ROLE, declareReleaseProtocol, RELEASE_PROTOCOL, RELEASE_VERSION } from '../src/release/protocol.ts'
import { createReleaseCommands } from '../src/release/commands.ts'
import { runVerifierSelftest } from '../src/verifier/implementation.ts'
import {
  declareEnvironmentProtocol,
  ENVIRONMENT_KINDS,
  ENVIRONMENT_PROTOCOL,
  ENVIRONMENT_ROLE,
  ENVIRONMENT_VERSION,
  PUBLISHER_ROLE,
} from '../src/environment/protocol.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ADAPTER = join(HERE, 'measure-runner.mjs')

const CONTROL = 'cd-probe'
const ENVIRONMENT = 'library-1'
const TASK = 'cd-task'
const AGENT = 'cd-agent'
const METER = 'meter'
const SELECTOR = 'selector'
const BOUNDS = 'bounds'
const MODEL = 'cd-probe-model-1'
const OTHER_MODEL = 'cd-probe-model-2'
const CONDITIONS = ['no-network']
const ALICE = 'human:alice'
const ROUNDS = 4
const FIRST_BUDGET = 4
const MINIMUM_BUDGET = 1
const FLOOR = { floor: 0.1, source: 'measured' }
const METRIC = { unit: 'score', direction: 'higher' }
const WEIGHTS = { quality: 100, cost: 15 }
const INPUT_NAME = 'in/words.txt'
const REFERENCE_NAME = 'in/reference.txt'
const NOISE_NAME = 'in/noise.txt'

/** The reference the selections are scored against, and the words a method must not select. */
const REFERENCE = Array.from({ length: 10 }, (_, index) => `t${String(index + 1).padStart(2, '0')}`)
const NOISE = ['n01', 'n02', 'n03', 'n04']
const WORDS = [...REFERENCE, ...NOISE]

/**
 * One revision's method: the words it selects, in one real file on disk.
 *
 * A revision's manifest declares the *digest* of its method file, so a trial's number is bound to
 * the content the revision declared rather than to this probe's memory of what it wrote.
 */
const METHODS = {
  r0001: REFERENCE.slice(0, 4), // 0.40 — the incumbent, measured A/A before round 1
  r0002: REFERENCE.slice(0, 7), // 0.70 — round 1 slot 0, the winner
  r0003: [...REFERENCE.slice(0, 9), NOISE[0]], // 0.90 and out of bounds — round 1 slot 1
  r0004: [...REFERENCE], // 1.00 in one trial, one trial missed — round 1 slot 2
  r0005: REFERENCE.slice(0, 9), // 0.90 — round 2 slot 0, the winner
  r0006: REFERENCE.slice(0, 8), // 0.80 — round 2 slot 1
  r0007: REFERENCE.slice(0, 7), // 0.70 — the isolation round's pooled side
  r0008: REFERENCE.slice(0, 8), // 0.80 — the isolation round's other-model side
  r0009: REFERENCE.slice(0, 9), // 0.90 — the isolation round's rebuilt-tool side
}

/**
 * The fixed apparatus, in three real programs.
 *
 * `selector-runtime.mjs` applies the *revision's* method — the words its manifest declares — to the
 * input and writes the artifact. It is the same bytes for every candidate, which is why every bubble
 * measured under one context declares one tool digest: what differs between candidates is the
 * revision under test, and the *apparatus* around it must not. `meter.mjs` is the implementation the
 * metric names: it computes the number from the artifact the selector wrote, and `mode = fail`
 * produces no number, so the adapter reports a miss rather than a zero. `selector-runtime-rebuilt`
 * is the same selection rule written differently — other bytes, so another tool identity — which is
 * what the second isolation round measures under.
 */
const SELECTOR_SOURCE = [
  "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'",
  'const [inputPath, artifactPath, methodPath, markerPath, label] = process.argv.slice(2)',
  'appendFileSync(markerPath, `selector:${label}\\n`)',
  "const words = readFileSync(inputPath, 'utf8').trim().split(/\\s+/).filter(Boolean)",
  "const method = JSON.parse(readFileSync(methodPath, 'utf8'))",
  "writeFileSync(artifactPath, words.filter(word => method.words.includes(word)).join(' '))",
].join('\n')

const SELECTOR_REBUILT_SOURCE = [
  "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'",
  'const [inputPath, artifactPath, methodPath, markerPath, label] = process.argv.slice(2)',
  'appendFileSync(markerPath, `selector-rebuilt:${label}\\n`)',
  "const wanted = new Set(JSON.parse(readFileSync(methodPath, 'utf8')).words)",
  "const words = readFileSync(inputPath, 'utf8').trim().split(/\\s+/).filter(Boolean)",
  "writeFileSync(artifactPath, words.filter(word => wanted.has(word)).join(' '))",
].join('\n')

const METER_SOURCE = [
  "import { appendFileSync, readFileSync } from 'node:fs'",
  'const [artifactPath, referencePath, markerPath, label, mode] = process.argv.slice(2)',
  'appendFileSync(markerPath, `meter:${label}\\n`)',
  "if (mode === 'fail') process.exit(3)",
  "const selected = readFileSync(artifactPath, 'utf8').trim().split(/\\s+/).filter(Boolean)",
  "const reference = readFileSync(referencePath, 'utf8').trim().split(/\\s+/).filter(Boolean)",
  'const hits = selected.filter(word => reference.includes(word)).length',
  "console.log(JSON.stringify({ quality: hits / reference.length, cost: selected.join(' ').length / 1000 }))",
].join('\n')

/** The constraint program: exit 0 when the artifact holds no noise word, exit 1 when it does. */
const BOUNDS_SOURCE = [
  "import { appendFileSync, readFileSync } from 'node:fs'",
  'const [artifactPath, noisePath, markerPath, label] = process.argv.slice(2)',
  'appendFileSync(markerPath, `bounds:${label}\\n`)',
  "const selected = readFileSync(artifactPath, 'utf8').trim().split(/\\s+/).filter(Boolean)",
  "const noise = readFileSync(noisePath, 'utf8').trim().split(/\\s+/).filter(Boolean)",
  'process.exit(selected.some(word => noise.includes(word)) ? 1 : 0)',
].join('\n')

const failures = []
let checks = 0
let refusals = 0
function check(label, condition, detail) {
  checks += 1
  if (condition) console.log(`  ok    ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const close = (left, right) => Math.abs(left - right) < 1e-12

/** One process for real, without letting a non-zero exit throw. */
function runProcess(file, args) {
  return new Promise(resolve => {
    execFile(file, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr })
    })
  })
}

/**
 * The refusal a step raised.
 *
 * A step that is **accepted** is reported as `no-refusal` instead of thrown: a mutated build must
 * fail the check that names the rule it broke, not abort the probe with a stack trace half way
 * through. This is the same reason every other check here accumulates instead of returning early.
 */
async function asyncRefusalOf(step) {
  try {
    await step()
  } catch (error) {
    if (error instanceof ProtocolRefusal) {
      refusals += 1
      return error.refusal
    }
    throw error
  }
  return { code: 'no-refusal', detail: 'the step was accepted; this probe expected a refusal, so the rule it names is not being enforced' }
}

/** An argv as one shell line; every entry is quoted rather than pasted. */
const shellLine = argv => argv.map(entry => JSON.stringify(String(entry))).join(' ')

/** Count the real invocations of each program, by the label the program itself appended. */
async function markerCounts(marker) {
  const text = await readFile(marker, 'utf8').catch(() => '')
  const lines = text.trim().split('\n').filter(Boolean)
  return {
    trials: lines.filter(entry => entry.startsWith('meter:run:')).length,
    checks: lines.filter(entry => entry.startsWith('meter:check:')).length,
    samples: lines.filter(entry => entry === 'meter:sample').length,
    selectors: lines.filter(entry => entry.startsWith('selector:')).length,
    rebuilt: lines.filter(entry => entry.startsWith('selector-rebuilt:')).map(entry => entry.slice('selector-rebuilt:'.length)),
    bounds: lines.filter(entry => entry.startsWith('bounds:') && entry !== 'bounds:sample').length,
  }
}

/** The measurement program path, set before anything measures. */
let meterProgram = ''

/** The real measurement port: spawn the adapter, then report the digest of what actually ran. */
function realMeasurement() {
  return async execution => {
    const request = {
      command: typeof execution.command === 'string' ? execution.command : execution.command.join(' '),
      artifactPath: execution.artifactPath,
      inputs: execution.inputs.map(entry => ({ name: entry.name, digest: entry.digest, path: entry.path })),
    }
    const result = await runProcess(process.execPath, [ADAPTER, JSON.stringify(request)])
    if (result.code !== 0) throw new Error(`the adapter could not measure: ${result.stderr}`)
    const reported = JSON.parse(result.stdout.trimEnd().split('\n')[0] ?? '{}')
    if (reported.missed !== undefined) return { reason: reported.missed }
    return {
      quality: reported.quality,
      ...(reported.cost === undefined ? {} : { cost: reported.cost }),
      // Read from the bytes that ran, at the moment they ran: the port takes no caller's word.
      implementationDigest: sha256(await readFile(meterProgram)),
      detail: reported.detail,
    }
  }
}

/** The smallest real runtime that can drive a turn: the agent loop plus a scripted adapter. */
async function mountRuntime(root) {
  const { Context } = await dshModule('@deepseek-ai/cordis')
  const { default: JsonlSessionPersistence } = await dshModule('@deepseek-ai/dsh-session-persistence-jsonl')
  const { SessionStore } = await dshModule('@deepseek-ai/dsh-session')
  const { default: AgentRegistry } = await dshModule('@deepseek-ai/dsh-agent')
  const { default: LlmRuntime, LlmAdapter } = await dshModule('@deepseek-ai/dsh-llm')
  const { default: ToolRuntime } = await dshModule('@deepseek-ai/dsh-tools')
  const { default: SystemPrompt } = await dshModule('@deepseek-ai/dsh-system-prompt')
  const { default: SessionProjectionRegistry } = await dshModule('@deepseek-ai/dsh-session-projection')
  const { default: AgentLoop } = await dshModule('@deepseek-ai/dsh-agent-loop')
  const approval = await dshModule('@deepseek-ai/dsh-user-approval')

  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: 1 })
  // The real service: the answerer waterfall, per-session policy, and the log-only audit pair.
  await ctx.plugin(approval.default, {})
  return { ctx, LlmAdapter }
}

/** An adapter that asks for the approval tool on its first stream and answers with text after. */
function scriptedAdapter(LlmAdapter) {
  return class Scripted extends LlmAdapter {
    constructor() {
      super()
      this.step = 0
    }

    async *stream() {
      this.step += 1
      if (this.step % 2 === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id: `call-${this.step}`, name: 'cd_approve', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-${this.step}`, name: 'cd_approve', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

async function main() {
  // Resolved dynamically, after `dsh-control-runtime` registered its resolve hook: ESM links static
  // imports before evaluating any of them, so a hook registered during evaluation is too late.
  const { ControlSessionStore } = await import('../src/control/session-store.ts')
  const { SessionId } = await dshModule('@deepseek-ai/dsh-session')
  const { createUserMessage } = await dshModule('@deepseek-ai/dsh-llm')

  const root = await mkdtemp(join(tmpdir(), 'singularity-cd-probe-'))
  const workspace = join(root, 'workspace')
  const sessions = join(root, 'sessions')
  await mkdir(join(workspace, 'in'), { recursive: true })
  await mkdir(join(workspace, 'out'), { recursive: true })
  await mkdir(join(workspace, 'methods'), { recursive: true })
  await mkdir(sessions, { recursive: true })

  const marker = join(root, 'ran.log')
  const inputPath = join(workspace, INPUT_NAME)
  const referencePath = join(workspace, REFERENCE_NAME)
  const noisePath = join(workspace, NOISE_NAME)
  const methodPathOf = revisionId => join(workspace, 'methods', `${revisionId}.json`)
  meterProgram = join(root, 'meter.mjs')
  const boundsProgram = join(root, 'bounds.mjs')
  const selectorRuntime = join(root, 'selector-runtime.mjs')
  const selectorRebuiltRuntime = join(root, 'selector-runtime-rebuilt.mjs')
  await writeFile(inputPath, `${WORDS.join(' ')}\n`, 'utf8')
  await writeFile(referencePath, `${REFERENCE.join(' ')}\n`, 'utf8')
  await writeFile(noisePath, `${NOISE.join(' ')}\n`, 'utf8')
  await writeFile(meterProgram, METER_SOURCE, 'utf8')
  await writeFile(boundsProgram, BOUNDS_SOURCE, 'utf8')
  await writeFile(selectorRuntime, SELECTOR_SOURCE, 'utf8')
  await writeFile(selectorRebuiltRuntime, SELECTOR_REBUILT_SOURCE, 'utf8')
  for (const [revisionId, words] of Object.entries(METHODS)) await writeFile(methodPathOf(revisionId), `${JSON.stringify({ words })}\n`, 'utf8')

  const meterDigest = sha256(await readFile(meterProgram))
  const boundsDigest = sha256(await readFile(boundsProgram))
  const selectorDigest = sha256(await readFile(selectorRuntime))
  const selectorRebuiltDigest = sha256(await readFile(selectorRebuiltRuntime))
  const INPUTS = [{ name: INPUT_NAME, digest: sha256(await readFile(inputPath)) }]

  // One execution context per run: the model, the tool implementations the run could reach, the
  // conditions, and the inputs. Two runs declare the same one exactly when their bubbles declare all
  // four alike, which is what `contextDigestOf` takes comparability over.
  const toolsetOf = implementationDigest => [
    { name: SELECTOR, implementationDigest, version: '1' },
    { name: METER, implementationDigest: meterDigest, version: '1' },
  ]
  const CONTEXT = { model: MODEL, tools: toolsetOf(selectorDigest), conditions: CONDITIONS }
  const OTHER_MODEL_CONTEXT = { model: OTHER_MODEL, tools: toolsetOf(selectorDigest), conditions: CONDITIONS }
  const OTHER_TOOL_CONTEXT = { model: MODEL, tools: toolsetOf(selectorRebuiltDigest), conditions: CONDITIONS }

  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry)
  declareMeasureProtocol(registry)
  declareStrategyProtocol(registry)
  declareReleaseProtocol(registry)
  declareEnvironmentProtocol(registry)

  const subjects = {
    [SCHEDULER_ROLE]: 'scheduler-service',
    [verifierRoleOf({ verifierRef: METER, verifierVersion: '1' })]: 'meter-service',
    [verifierRoleOf({ verifierRef: BOUNDS, verifierVersion: '1' })]: 'bounds-service',
    [STRATEGY_ROLE]: 'strategy-service',
    [APPROVER_ROLE]: 'approval-seam',
    [ENVIRONMENT_ROLE]: 'environment-service',
    [PUBLISHER_ROLE]: 'publisher-service',
  }

  const { ctx, LlmAdapter } = await mountRuntime(sessions)
  const live = await openPersistence(sessions)
  let store = await ControlSessionStore.open({ persistence: live.persistence, controlId: CONTROL, registry, subjects, cwd: workspace })
  let commandSeq = 0
  const nextId = prefix => `${prefix}-${(commandSeq += 1)}`
  let handle

  try {
    ctx.llm.registerAdapter(['scripted'], new (scriptedAdapter(LlmAdapter))())
    handle = await ctx.agents.create({
      sessionId: SessionId('cd-probe-agent'),
      meta: { cwd: root },
      agentOptions: { provider: 'scripted', model: 'stub-1' },
    })

    const metric = {
      measured: {
        criterionId: 'quality',
        statement: 'the selection recovers the reference words',
        verifierRef: METER,
        verifierVersion: '1',
        implementationDigest: meterDigest,
      },
      unit: METRIC.unit,
      direction: METRIC.direction,
    }
    const judgement = [
      { criterionId: 'bounded', statement: 'the selection holds no noise word', verifierRef: BOUNDS, verifierVersion: '1', implementationDigest: boundsDigest },
    ]

    const measure = createMeasureCommands({
      store,
      registry,
      implementations: [
        { ref: METER, version: '1', implementationDigest: meterDigest },
        { ref: BOUNDS, version: '1', implementationDigest: boundsDigest },
      ],
      subjects,
    })
    const release = createReleaseCommands({ store, approvalSeams: { approval: ctx.approval, feed: ctx } })
    const commands = createStrategyCommands({
      store,
      rounds: ROUNDS,
      firstBudget: FIRST_BUDGET,
      minimumBudget: MINIMUM_BUDGET,
      calibration: FLOOR,
      // The measure slice, read at one committed cut. The two historical reads narrow that to the
      // round's own `historyCutoff`; a candidate's own evaluation is read at the cut.
      measuresAt: cut => sliceOf(cut),
    })

    const environmentOf = () => store.load().stateOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT)
    const measureStateOf = evaluationId => store.load().stateOf(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)
    const roundStateOf = roundId => store.load().stateOf(STRATEGY_PROTOCOL, STRATEGY_VERSION, roundId)
    const decisionOf = roundId => roundStateOf(roundId)?.decision
    const pinOf = revisionId => ({ environmentId: ENVIRONMENT, revisionId, digest: environmentOf().revisions[revisionId].contentDigest })
    const bubbleOf = runId => store.load().stateOf(TASK_PROTOCOL, TASK_VERSION, TASK).runs[runId]?.bubble
    const contextOf = evaluationId => contextDigestOf(bubbleOf(measureStateOf(evaluationId).run.runId))
    /** The bubble members two runs differ in: exactly what `contextDigestOf` is taken over. */
    const differingMembers = (left, right) => ['model', 'tools', 'conditions', 'inputs'].filter(key => digestOf(left[key]) !== digestOf(right[key]))

    /**
     * The measure slice as one round reads it, folded at the cut it is handed.
     *
     * `entries` is the log itself: what counts as *accepted* in it is `publishedAssetsBelow`'s one
     * derivation, not a convention invented here. An injected convention is how two wirings could
     * disagree about one log, and novelty feeds selection, so that disagreement is two winners.
     */
    function sliceOf(cut) {
      const belowCut = (protocol, version, cutoff) => cut.entriesOf(protocol, version).filter(entry => entry.seq < cutoff)
      return {
        entries: cut.entries(),
        evaluationOf: evaluationId => {
          const state = cut.stateOf(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)
          if (state === undefined || state.trials === undefined || state.baseline === undefined || state.candidate === undefined) return undefined
          const caliberDigest = caliberDigestOf(state)
          if (caliberDigest === undefined) return undefined
          return { evaluationId, caliberDigest, baseline: state.baseline, candidate: state.candidate, ...projectEvaluation(state) }
        },
        // The incumbent's own aggregate from facts **below the round's cutoff**: the last evaluation
        // opened there whose candidate is that revision — an A/A control for the first round, and a
        // previous round's own measurement of the revision it published for the second.
        incumbentBelow: (revision, cutoff) => {
          const entries = belowCut(MEASURE_PROTOCOL, MEASURE_VERSION, cutoff)
          const opened = entries.filter(entry => entry.kind === 'evaluation/opened' && sameRevision(entry.payload.candidate, revision)).at(-1)
          if (opened === undefined) return null
          const states = foldSubjects(registry, entries, MEASURE_PROTOCOL, MEASURE_VERSION)
          const view = projectEvaluation(states.get(opened.subject))
          return { quality: view.quality, cost: view.cost }
        },
      }
    }

    console.log(`session ${store.sessionId}; agent ${handle.agent.id}`)

    // ---------------------------------------------------------------- 1. revisions, runs and bubbles
    // Every revision is real content: `environment@2` computes the digest of the manifest, and each
    // manifest declares the digest of its method file, so a trial can be bound to that content.
    for (const [revisionId, words] of Object.entries(METHODS)) {
      const manifest = {
        skills: ['select-targets'],
        tools: revisionId === 'r0005' ? ['selector'] : [],
        taskTemplates: [],
        method: { file: `methods/${revisionId}.json`, words: words.length, digest: sha256(await readFile(methodPathOf(revisionId))) },
      }
      await store.emit({
        commandId: nextId(`create-${revisionId}`),
        protocol: ENVIRONMENT_PROTOCOL,
        version: ENVIRONMENT_VERSION,
        kind: ENVIRONMENT_KINDS.revisionCreated,
        subject: ENVIRONMENT,
        payload: { revisionId, manifest },
      })
    }
    const manifestDigestsHold = []
    for (const revisionId of Object.keys(METHODS))
      manifestDigestsHold.push(environmentOf().revisions[revisionId].manifest.method.digest === sha256(await readFile(methodPathOf(revisionId))))
    check('every revision declares, and the log holds, the digest of the method bytes on disk', manifestDigestsHold.every(Boolean))

    // The task every measurement run belongs to. Each *evaluation* then gets a run of its own with
    // its own bubble, so two candidates are two executions rather than one shared one — which is
    // exactly what a round now has to be able to compare, and what the isolation manifest declares.
    for (const [index, fact] of [
      {
        kind: TASK_KINDS.admitted,
        payload: {
          contract: {
            goal: 'measure candidate selections against a reference list',
            inputs: [INPUT_NAME],
            criteria: [{ criterionId: 'quality', statement: metric.measured.statement, verifierRef: METER, verifierVersion: '1', implementationDigest: meterDigest }],
          },
        },
      },
      { kind: TASK_KINDS.assigned, payload: { agentId: AGENT, agentIdentity: subjects[SCHEDULER_ROLE] } },
    ].entries())
      await store.emit({ commandId: nextId(`fixture-${index}`), protocol: TASK_PROTOCOL, version: TASK_VERSION, subject: TASK, ...fact })

    /** Open one run pinned to the revision under test, and declare the context it executes in. */
    const beginRun = async (runId, revisionId, context) => {
      await store.emit({
        commandId: nextId(`start-${runId}`),
        protocol: TASK_PROTOCOL,
        version: TASK_VERSION,
        kind: TASK_KINDS.runStarted,
        subject: TASK,
        payload: { runId, revision: pinOf(revisionId) },
      })
      await store.emit({
        commandId: nextId(`bubble-${runId}`),
        protocol: TASK_PROTOCOL,
        version: TASK_VERSION,
        kind: TASK_KINDS.bubbleOpened,
        subject: TASK,
        payload: { runId, inputs: INPUTS, workspace: { kind: 'dir', ref: workspace }, ...context },
      })
    }

    // The meter's declaration, with a selftest that must produce both verdicts: a gate that has never
    // failed is not known to work. Its samples are real artifacts and a real missing number.
    const cleanSample = join(root, 'clean-sample.txt')
    const brokenSample = join(root, 'broken-sample.txt')
    await writeFile(cleanSample, REFERENCE.slice(0, 4).join(' '), 'utf8')
    await writeFile(brokenSample, REFERENCE.slice(0, 2).join(' '), 'utf8')
    const meterImplementation = {
      ref: METER,
      version: '1',
      implementationDigest: meterDigest,
      selftest: {
        samples: [
          { name: 'measures a selection', expected: 'pass', input: { subject: cleanSample, artifactDigest: sha256('clean'), inputs: [] } },
          { name: 'produces no number for a failed run', expected: 'fail', input: { subject: brokenSample, artifactDigest: sha256('broken'), inputs: [] } },
        ],
      },
      judge: async sample => {
        const mode = sample.subject === cleanSample ? 'measure' : 'fail'
        const ran = await runProcess(process.execPath, [meterProgram, sample.subject, referencePath, marker, 'sample', mode])
        return { verdict: ran.code === 0 ? 'pass' : 'fail' }
      },
    }
    const noisySample = join(root, 'noisy-sample.txt')
    await writeFile(noisySample, [REFERENCE[0], NOISE[0]].join(' '), 'utf8')
    const boundsImplementation = {
      ref: BOUNDS,
      version: '1',
      implementationDigest: boundsDigest,
      selftest: {
        samples: [
          { name: 'passes a clean selection', expected: 'pass', input: { subject: cleanSample, artifactDigest: sha256('clean'), inputs: [] } },
          { name: 'fails a selection holding a noise word', expected: 'fail', input: { subject: noisySample, artifactDigest: sha256('noisy'), inputs: [] } },
        ],
      },
      judge: async sample => {
        const ran = await runProcess(process.execPath, [boundsProgram, sample.subject, noisePath, marker, 'sample'])
        return { verdict: ran.code === 0 ? 'pass' : 'fail' }
      },
    }
    const boundsSelftest = await runVerifierSelftest(boundsImplementation)
    check('the constraint program produces both verdicts on real samples', boundsSelftest.ran === 2 && boundsSelftest.failures.length === 0, JSON.stringify(boundsSelftest.failures))

    // ---------------------------------------------------------------- 2. real trials
    let artifactsHashedAfterTheRun = 0
    let trialsRecorded = 0
    let missesRecorded = 0
    const measureSlot = async (evaluationId, slot, revisionId, mode, runtimePath) => {
      const artifactName = `out/${evaluationId}-${slot}.txt`
      const artifactPath = join(workspace, artifactName)
      const label = `run:${evaluationId}:${slot}`
      const outcome = await runMeasurement({
        metric: metric.measured,
        implementations: [meterImplementation],
        inputs: INPUTS,
        workspace,
        artifactPath: artifactName,
        // Two real programs: the run's declared selector runtime applies the revision's method and
        // writes the artifact; the meter, the implementation the metric names, prints the number. A
        // candidate whose run used a rebuilt selector passes that build here, and its bubble says so.
        command: `${shellLine([process.execPath, runtimePath, inputPath, artifactPath, methodPathOf(revisionId), marker, label])} && ${shellLine([
          process.execPath,
          meterProgram,
          artifactPath,
          referencePath,
          marker,
          label,
          mode,
        ])}`,
        measure: realMeasurement(),
      })
      if (outcome.kind === 'missed') {
        missesRecorded += 1
        await measure.missTrial({ commandId: nextId(`miss-${evaluationId}-${slot}`), evaluationId, slot, reason: outcome.reason })
        return outcome
      }
      trialsRecorded += 1
      // Read the artifact back here, before any later run overwrites the file: the digest in the
      // fact must be the digest of the bytes that are on disk now.
      const onDisk = sha256(await readFile(artifactPath))
      if (onDisk === outcome.trial.artifactDigest) artifactsHashedAfterTheRun += 1
      await measure.recordTrial({ commandId: nextId(`trial-${evaluationId}-${slot}`), evaluationId, trial: { slot, ...outcome.trial } })
      return outcome
    }

    /**
     * One evaluation: its own run and bubble, its trials for real, its constraint for real.
     *
     * `context` is what the bubble declares (model, tools, conditions) and `runtime` is the selector
     * build that run actually executes; the evaluation's context digest is read back from the run's
     * bubble by the command, never passed in.
     */
    const measurementOf = async (evaluationId, revisionId, modes, options = {}) => {
      const runId = `run-${evaluationId}`
      await beginRun(runId, revisionId, options.context ?? CONTEXT)
      await measure.openEvaluation({
        commandId: nextId(`open-${evaluationId}`),
        evaluationId,
        baseline: pinOf(options.baseline ?? revisionId),
        candidate: pinOf(revisionId),
        run: { taskId: TASK, runId },
        metric,
        weights: WEIGHTS,
        trials: 2,
        judgement,
      })
      for (const [slot, mode] of modes.entries()) await measureSlot(evaluationId, slot, revisionId, mode, options.runtime ?? selectorRuntime)
      const state = measureStateOf(evaluationId)
      const observation = state.observed[0]
      const artifactPath = join(workspace, `out/${evaluationId}-0.txt`)
      const onDisk = sha256(await readFile(artifactPath))
      const boundsRan = await runProcess(process.execPath, [boundsProgram, artifactPath, noisePath, marker, evaluationId])
      await measure.checkConstraint({
        commandId: nextId(`check-${evaluationId}`),
        evaluationId,
        criterionId: 'bounded',
        met: boundsRan.code === 0,
        artifactDigest: observation.artifactDigest,
        implementationDigest: boundsDigest,
      })
      check(`the constraint of ${evaluationId} was checked on the bytes its number was formed on`, onDisk === observation.artifactDigest)
      return projectEvaluation(measureStateOf(evaluationId))
    }

    // ---------------------------------------------------------------- 3. round one
    console.log('\n== round one: three candidates against one incumbent')
    // The A/A control R06 asks for: the incumbent measured against itself, before any round opens, so
    // the round has a frozen baseline to compute every gain against. Without it nothing lies below
    // the round's cutoff and the round can only retain the incumbent.
    const baselineOne = await measurementOf('r1-baseline', 'r0001', ['measure', 'measure'])
    check('the incumbent baseline is an A/A control measured on itself', sameRevision(measureStateOf('r1-baseline').baseline, measureStateOf('r1-baseline').candidate))
    check('the A/A baseline is complete with the plan\'s denominator', baselineOne.denominator === 2 && baselineOne.observed === 2 && close(baselineOne.quality, 0.4), `quality ${baselineOne.quality}`)
    const baselineOneLastSeq = store.load().entries().at(-1).seq

    const CANDIDATE_ONE = [
      { slot: 0, revisionId: 'r0002', evaluationId: 'r1-c0', edits: [{ asset: 'skill', target: 'select-targets' }] },
      { slot: 1, revisionId: 'r0003', evaluationId: 'r1-c1', edits: [{ asset: 'skill', target: 'select-targets' }] },
      { slot: 2, revisionId: 'r0004', evaluationId: 'r1-c2', edits: [{ asset: 'skill', target: 'select-targets' }] },
    ]
    await commands.openRound({
      commandId: nextId('open-round-1'),
      roundId: 'round-1',
      round: 1,
      incumbent: pinOf('r0001'),
      candidates: 3,
      explorationSlots: 0,
      historyCutoff: store.load().entries().length,
      // The question every pooled candidate must have answered: the incumbent's own caliber, which
      // is derived from the frozen plan and not invented here.
      caliber: caliberDigestOf(measureStateOf('r1-baseline')),
      metric: { direction: METRIC.direction },
      weights: WEIGHTS,
    })
    // Each candidate is measured **against the round's incumbent**, which is what makes its gain
    // this round's gain: the evaluation's own baseline is checked by the projection, not assumed.
    const one = await measurementOf('r1-c0', 'r0002', ['measure', 'measure'], { baseline: 'r0001' })
    const outOfBounds = await measurementOf('r1-c1', 'r0003', ['measure', 'measure'], { baseline: 'r0001' })
    const incomplete = await measurementOf('r1-c2', 'r0004', ['measure', 'fail'], { baseline: 'r0001' })
    for (const candidate of CANDIDATE_ONE)
      await commands.submitCandidate({
        commandId: nextId(`submit-${candidate.evaluationId}`),
        roundId: 'round-1',
        slot: candidate.slot,
        revision: pinOf(candidate.revisionId),
        evaluationId: candidate.evaluationId,
        edits: candidate.edits,
        exploratory: false,
      })

    const planOne = roundStateOf('round-1').plan
    check('the round froze a cutoff strictly after the incumbent\'s own measurement', planOne.historyCutoff > baselineOneLastSeq, `cutoff ${planOne.historyCutoff} vs the baseline's last fact ${baselineOneLastSeq}`)
    check('the incumbent therefore has a frozen aggregate below the cutoff', sliceOf(store.load()).incumbentBelow(pinOf('r0001'), planOne.historyCutoff) !== null)
    check('every candidate in round one was measured under the round\'s own caliber',
      CANDIDATE_ONE.every(candidate => caliberDigestOf(measureStateOf(candidate.evaluationId)) === planOne.caliber))
    // The thing that was impossible while `run` was inside the caliber: three candidates, three
    // executions, three bubbles — and still one comparison.
    const runsOf = candidate => measureStateOf(candidate.evaluationId).run.runId
    check('round one\'s candidates were measured in three different runs, each with its own bubble',
      new Set(CANDIDATE_ONE.map(runsOf)).size === 3 && CANDIDATE_ONE.every(candidate => bubbleOf(runsOf(candidate))?.runId === runsOf(candidate)))
    check('each evaluation froze the context digest of its own run\'s bubble, read and not supplied',
      CANDIDATE_ONE.every(candidate => measureStateOf(candidate.evaluationId).context === contextOf(candidate.evaluationId)))
    check('those bubbles declare the same model, the same tool digests and the same conditions',
      new Set(CANDIDATE_ONE.map(candidate => contextOf(candidate.evaluationId))).size === 1 &&
      differingMembers(bubbleOf(runsOf(CANDIDATE_ONE[0])), bubbleOf(runsOf(CANDIDATE_ONE[1]))).length === 0)
    check('every trial in the log names the implementation that produced it, by content digest',
      ['r1-baseline', 'r1-c0', 'r1-c1', 'r1-c2'].every(id => measureStateOf(id).observed.every(trial => trial.implementationDigest === meterDigest)))
    check('every trial is bound to the inputs the run\'s bubble declared',
      ['r1-baseline', 'r1-c0', 'r1-c1', 'r1-c2'].every(id => measureStateOf(id).observed.every(trial => JSON.stringify(trial.inputDigests) === JSON.stringify(INPUTS))))
    check('the numbers are the ones the program computed from the method bytes, not caller claims',
      close(baselineOne.quality, 4 / 10) && close(one.quality, 7 / 10) && close(outOfBounds.quality, 9 / 10) && close(incomplete.observed, 1) && close(incomplete.quality, 10 / 10 / 2))

    const projectedOne = projectRound(roundStateOf('round-1'), sliceOf(store.load()), FLOOR)
    const [good, outOfBand, short] = [...projectedOne.slots].sort((left, right) => left.slot - right.slot)
    check('round one pools three candidates from one incumbent and elects slot 0', projectedOne.winner === 0, `winner ${projectedOne.winner}`)
    check('none of the three was refused for its caliber, so three runs were ranked together',
      new Set(CANDIDATE_ONE.map(runsOf)).size === 3 && projectedOne.slots.every(slot => !(slot.reason ?? '').includes('caliber')))
    check('the missing denominator is the plan\'s, not the observations\'', short.denominator === 2 && incomplete.observed === 1 && close(short.quality, 0.5), `denominator ${short.denominator}, quality ${short.quality}`)
    // R06's measured defect was `quality = 1, expected = 2, incomplete = true`: one lucky run read as
    // a complete score. Here the observation is perfect and the aggregate is still one half.
    check('the R06 defect — one observation read as the whole score — is absent', close(incomplete.observed, 1) && short.denominator !== incomplete.observed && !close(short.quality, 1))
    check('the empty slot is named, with the reason the miss recorded', short.missingTrials.length === 1 && short.missingTrials[0].slot === 1 && short.missingTrials[0].reason.includes('exited 3'), JSON.stringify(short.missingTrials.map(entry => entry.slot)))
    check('the incomplete candidate is inadmissible for the missing trial, not for a score', short.admissible === false && (short.reason ?? '').includes('incomplete') && (short.reason ?? '').includes('missing slot 1'), short.reason)
    check('the out-of-bounds candidate scored higher than the winner', outOfBand.quality > good.quality, `${outOfBand.quality} vs ${good.quality}`)
    check('a high score outside a hard constraint does not win', projectedOne.winner !== 1 && outOfBand.admissible === false, `admissible ${outOfBand.admissible}`)
    check('its reason names the constraint, from the constraint\'s own check', (outOfBand.reason ?? '').includes('hard constraint "bounded"') && outOfBand.constraintsMet === false, outOfBand.reason)
    // The release half of the same rule: what the pipeline takes forward is the revision the decision
    // elected, and the revision the round refused is a different one.
    const electedRevision = roundStateOf('round-1').submissions.find(entry => entry.slot === projectedOne.winner)?.revision.revisionId
    const refusedRevision = roundStateOf('round-1').submissions.find(entry => entry.evaluationId === 'r1-c1')?.revision.revisionId
    check('the elected revision is not the one the round refused', electedRevision === 'r0002' && refusedRevision === 'r0003', `${electedRevision} vs ${refusedRevision}`)
    check('the winner is admitted with a frozen gain against the incumbent\'s aggregate below the cutoff', good.admissible === true && close(good.gain, 0.7 - 0.4), `gain ${good.gain}`)
    check('every slot is closed out with a reason', projectedOne.outcomes.length === 3 && projectedOne.outcomes.every(outcome => typeof outcome.reason === 'string' && outcome.reason.length > 0))

    await commands.decideRound({ commandId: nextId('decide-round-1'), roundId: 'round-1' })
    const decidedOne = decisionOf('round-1')
    check('the decision records the winner the projection implied', decidedOne.winner === 0, `winner ${decidedOne.winner}`)
    check('the decision freezes the band it was made under', decidedOne.calibration.floor === FLOOR.floor && decidedOne.calibration.source === FLOOR.source)

    // ---------------------------------------------------------------- 4. the controlled release
    console.log('\n== the release path: one draft, a native ask, a compare-and-swap head')
    /** The one approval the next tool call is asked to record, and the answerer chain's answer. */
    let pending
    const answerer = ctx.on('approval/request', async () => 'allowed-once')
    ctx.tools.register({
      name: 'cd_approve',
      description: 'record a human authorisation of the drafted revision',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (_args, exec) => {
        const request = pending
        if (request === undefined) return { skipped: true }
        try {
          const envelope = await release.approve({
            commandId: request.commandId,
            environmentId: ENVIRONMENT,
            revisionId: request.revisionId,
            draftDigest: request.draftDigest,
            approvedBy: ALICE,
            ask: { agent: exec.agent, toolName: 'cd_approve', callId: exec.callId, reason: 'publishing this content is a decision' },
          })
          return { approved: true, approvalId: envelope.payload.approvalId }
        } catch (error) {
          if (error instanceof ProtocolRefusal) {
            refusals += 1
            return { refused: error.refusal.code, detail: error.refusal.detail }
          }
          throw error
        }
      },
    })
    const userMessage = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    const approveThroughTheSeam = async (request, label) => {
      pending = request
      handle.agent.followup(userMessage(label))
      await handle.agent.whenIdle()
      const events = handle.agent.session.snapshotEvents()
      const result = events.filter(event => event.type === 'tool/result').at(-1)?.data?.message?.content
      return {
        answer: JSON.parse(result?.[0]?.text ?? '{}'),
        asked: events.filter(event => event.type === 'approval/asked').at(-1)?.data,
        decided: events.filter(event => event.type === 'approval/decided').at(-1)?.data,
      }
    }
    const releaseOf = () => store.load().stateOf(RELEASE_PROTOCOL, RELEASE_VERSION, ENVIRONMENT)
    const pointerFacts = () => store.load().entriesOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).filter(entry => entry.kind === ENVIRONMENT_KINDS.pointerSwitched)

    const noDraft = await asyncRefusalOf(() => release.publish({ commandId: nextId('publish-r0002'), environmentId: ENVIRONMENT, expected: '', to: 'r0002' }))
    check('a head does not move onto a revision nobody drafted', noDraft.code === 'unapproved-revision', noDraft.code)
    await release.draft({ commandId: nextId('draft-r0002'), revision: pinOf('r0002') })
    check('the draft binds the content digest this environment actually holds', releaseOf().draftDigest === pinOf('r0002').digest && releaseOf().revisionId === 'r0002')
    const unapproved = await asyncRefusalOf(() => release.publish({ commandId: nextId('publish-r0002-unapproved'), environmentId: ENVIRONMENT, expected: '', to: 'r0002' }))
    check('publishing a drafted but unapproved revision is refused', unapproved.code === 'unapproved-revision' && unapproved.detail.includes('carries no approval'), unapproved.code)
    const loser = await asyncRefusalOf(() => release.publish({ commandId: nextId('publish-r0003'), environmentId: ENVIRONMENT, expected: '', to: 'r0003' }))
    check('the release path cannot publish the candidate the round refused', loser.code === 'unapproved-revision', loser.code)

    const granted = await approveThroughTheSeam({ commandId: nextId('approve-r0002'), revisionId: 'r0002', draftDigest: pinOf('r0002').digest }, 'approve the drafted winner')
    check('the native ask granted once and the log recorded it', granted.answer.approved === true && granted.decided?.outcome === 'allowed-once', JSON.stringify(granted.answer))
    check('the approval fact carries the audit id of the ask that produced it', releaseOf().approvalId === granted.asked?.id && granted.asked?.id === granted.decided?.id, `${releaseOf().approvalId} vs ${granted.asked?.id}`)
    check('the approval names the human and the content on the table', releaseOf().approvedBy === ALICE && releaseOf().draftDigest === pinOf('r0002').digest)

    await release.publish({ commandId: nextId('publish-r0002-approved'), environmentId: ENVIRONMENT, expected: '', to: 'r0002' })
    check('the head moves onto the approved revision by compare-and-swap', environmentOf().pointer === 'r0002')
    const moved = await asyncRefusalOf(() => release.publish({ commandId: nextId('publish-r0002-again'), environmentId: ENVIRONMENT, expected: '', to: 'r0002' }))
    check('a switch whose expected head already moved is refused', moved.code === 'illegal-transition', moved.code)
    check('neither refused switch reached the log', pointerFacts().length === 1, String(pointerFacts().length))

    // ---------------------------------------------------------------- 5. round two reads round one
    console.log('\n== round two: the new incumbent is the revision round one published')
    const headAfterRoundOne = environmentOf().pointer
    const firstPublishSeq = pointerFacts()[0].seq
    const roundOneDecisionSeq = store.load().entriesOf(STRATEGY_PROTOCOL, STRATEGY_VERSION).filter(entry => entry.subject === 'round-1' && entry.kind === 'round/decided')[0].seq
    // Round two's own A/A control, recorded before its cutoff, so its incumbent has a frozen
    // aggregate below that cutoff: the same discipline round one needed.
    const baselineTwo = await measurementOf('r2-baseline', 'r0002', ['measure', 'measure'])
    check('round two\'s incumbent carries a baseline of its own', close(baselineTwo.quality, 0.7) && baselineTwo.observed === 2)
    const baselineTwoLastSeq = store.load().entries().at(-1).seq
    await commands.openRound({
      commandId: nextId('open-round-2'),
      roundId: 'round-2',
      round: 2,
      incumbent: pinOf('r0002'),
      candidates: 2,
      explorationSlots: 0,
      historyCutoff: store.load().entries().length,
      caliber: caliberDigestOf(measureStateOf('r2-baseline')),
      metric: { direction: METRIC.direction },
      weights: WEIGHTS,
    })
    const planTwo = roundStateOf('round-2').plan
    check('round two\'s incumbent is the revision round one published', headAfterRoundOne === 'r0002' && sameRevision(planTwo.incumbent, pinOf('r0002')) && planTwo.incumbent.digest === environmentOf().revisions['r0002'].contentDigest)
    check('round two\'s cutoff sits after round one\'s decision and after its publication', planTwo.historyCutoff > roundOneDecisionSeq && planTwo.historyCutoff > firstPublishSeq, `cutoff ${planTwo.historyCutoff} vs decision ${roundOneDecisionSeq}`)
    check('and after round two\'s own incumbent baseline', planTwo.historyCutoff > baselineTwoLastSeq, `cutoff ${planTwo.historyCutoff} vs ${baselineTwoLastSeq}`)
    const CANDIDATE_TWO = [
      { slot: 0, revisionId: 'r0005', evaluationId: 'r2-c0', edits: [{ asset: 'skill', target: 'select-targets' }, { asset: 'tool', target: 'selector' }] },
      { slot: 1, revisionId: 'r0006', evaluationId: 'r2-c1', edits: [{ asset: 'skill', target: 'select-targets' }] },
    ]
    const twoOne = await measurementOf('r2-c0', 'r0005', ['measure', 'measure'], { baseline: 'r0002' })
    const twoTwo = await measurementOf('r2-c1', 'r0006', ['measure', 'measure'], { baseline: 'r0002' })
    for (const candidate of CANDIDATE_TWO)
      await commands.submitCandidate({
        commandId: nextId(`submit-${candidate.evaluationId}`),
        roundId: 'round-2',
        slot: candidate.slot,
        revision: pinOf(candidate.revisionId),
        evaluationId: candidate.evaluationId,
        edits: candidate.edits,
        exploratory: false,
      })

    const projectedTwo = projectRound(roundStateOf('round-2'), sliceOf(store.load()), FLOOR)
    const [novel, known] = [...projectedTwo.slots].sort((left, right) => left.slot - right.slot)
    const incumbentQuality = projectEvaluation(measureStateOf('r2-baseline')).quality
    check('round two counts novelty against the asset class round one published', novel.novelty === 1 && known.novelty === 0, `slot 0 novelty ${novel.novelty}, slot 1 novelty ${known.novelty}`)
    // The counterfactual is the *same log with one fact removed* — the switch that made r0002 the
    // head — so novelty really reads 2 and 1 instead of being asserted: `publishedAssetsBelow` folds
    // the head out of the entries it is handed, and with the switch gone there is no head and no
    // accepted class. A counterfactual that cannot differ from the live reading is a check that
    // cannot fail, which is the defect this probe exists to catch in other people's wiring.
    const publication = pointerFacts()[0]
    const withoutPublication = store.load().entries().filter(entry => entry.seq !== publication.seq)
    const unread = projectRound(roundStateOf('round-2'), { ...sliceOf(store.load()), entries: withoutPublication }, FLOOR)
    check('the counterfactual is the live log minus that one publication fact',
      withoutPublication.length === store.load().entries().length - 1 && withoutPublication.every(entry => entry.seq !== publication.seq) && publication.payload.to === 'r0002')
    check('with the publication removed from the log the same slots really read as novel', unread.slots[0].novelty === 2 && unread.slots[1].novelty === 1, JSON.stringify(unread.slots.map(slot => slot.novelty)))
    check('and only novelty moves: the same winner and the same frozen gains', unread.winner === projectedTwo.winner && close(unread.slots[0].gain, novel.gain) && close(unread.slots[1].gain, known.gain))
    check('round two\'s frozen gain is relative to round one\'s incumbent', close(novel.gain, twoOne.quality - incumbentQuality) && !close(incumbentQuality, baselineOne.quality), `gain ${novel.gain}, incumbent ${incumbentQuality}`)
    check('both of round two\'s candidates are admissible, so the argmax ranks them', novel.admissible === true && known.admissible === true)
    check('the higher quality wins round two', projectedTwo.winner === 0 && close(novel.quality, 0.9) && close(known.quality, 0.8), `winner ${projectedTwo.winner}`)
    check('round two\'s two candidates were also measured in two runs under one context',
      new Set([measureStateOf('r2-c0').run.runId, measureStateOf('r2-c1').run.runId]).size === 2 &&
      contextOf('r2-c0') === contextOf('r2-c1') &&
      projectedTwo.slots.every(slot => !(slot.reason ?? '').includes('caliber')))

    await commands.decideRound({ commandId: nextId('decide-round-2'), roundId: 'round-2' })
    const selectionDigest = roundId => digestOf({ winner: decisionOf(roundId).winner, outcomes: decisionOf(roundId).outcomes })
    check('the decision records slot 0 as the winner and closes both slots', decisionOf('round-2').winner === 0 && decisionOf('round-2').outcomes.length === 2)

    // ---------------------------------------------------------------- 6. releasing round two's winner
    await release.draft({ commandId: nextId('draft-r0005'), revision: pinOf('r0005') })
    check('a new draft supersedes the standing one and clears its approval', releaseOf().revisionId === 'r0005' && releaseOf().approvedBy === undefined)
    const stale = await approveThroughTheSeam({ commandId: nextId('approve-stale'), revisionId: 'r0005', draftDigest: pinOf('r0002').digest }, 'approve the wrong content')
    check('an approval naming content other than the draft\'s is refused as stale', stale.answer.refused === 'stale-approval', JSON.stringify(stale.answer))
    check('the refused approval left no approval on the table', releaseOf().approvedBy === undefined && releaseOf().revisionId === 'r0005')
    const grantedTwo = await approveThroughTheSeam({ commandId: nextId('approve-r0005'), revisionId: 'r0005', draftDigest: pinOf('r0005').digest }, 'approve the drafted winner')
    check('the second grant is recorded with its own audit id', grantedTwo.answer.approved === true && releaseOf().approvalId === grantedTwo.asked?.id)

    const racedAway = await asyncRefusalOf(() => release.publish({ commandId: nextId('publish-r0005-stale-head'), environmentId: ENVIRONMENT, expected: '', to: 'r0005' }))
    check('an approved target does not rescue a switch whose expected head moved', racedAway.code === 'illegal-transition', racedAway.code)
    await release.publish({ commandId: nextId('publish-r0005'), environmentId: ENVIRONMENT, expected: 'r0002', to: 'r0005' })
    check('the second publish moves the head from the revision it read', environmentOf().pointer === 'r0005')
    const refusedLoser = await asyncRefusalOf(() => release.publish({ commandId: nextId('publish-r0003-final'), environmentId: ENVIRONMENT, expected: 'r0005', to: 'r0003' }))
    check('a standing approval for another revision does not publish the refused candidate', refusedLoser.code === 'unapproved-revision' && refusedLoser.detail.includes('authorises revision "r0005"'), refusedLoser.detail)
    check('no release fact ever named the refused candidate', store.load().entriesOf(RELEASE_PROTOCOL, RELEASE_VERSION).every(entry => entry.payload.revisionId !== 'r0003'))
    check('the head is the approved revision, and no more switches reached the log', environmentOf().pointer === 'r0005' && pointerFacts().length === 2, String(pointerFacts().length))

    // ---------------------------------------------------------------- 7. isolation, and its limit
    console.log('\n== isolation: one run and one bubble each, and where comparability ends')
    // Three candidates, each in a run of its own with its own bubble: one under the pooled context,
    // one declaring another model, one whose run executes a rebuilt selector. The last two are the
    // negative: comparability is over the context, so differing in it must end the pooling.
    const isoA = await measurementOf('iso-a', 'r0007', ['measure', 'measure'])
    const isoB = await measurementOf('iso-b', 'r0008', ['measure', 'measure'], { context: OTHER_MODEL_CONTEXT })
    const isoC = await measurementOf('iso-c', 'r0009', ['measure', 'measure'], { context: OTHER_TOOL_CONTEXT, runtime: selectorRebuiltRuntime })
    const isoRun = evaluationId => measureStateOf(evaluationId).run.runId
    const modelDiff = differingMembers(bubbleOf(isoRun('iso-a')), bubbleOf(isoRun('iso-b')))
    const toolDiff = differingMembers(bubbleOf(isoRun('iso-a')), bubbleOf(isoRun('iso-c')))
    check('the three isolation candidates are three runs with three bubbles',
      new Set([isoRun('iso-a'), isoRun('iso-b'), isoRun('iso-c')]).size === 3 &&
      ['iso-a', 'iso-b', 'iso-c'].every(id => bubbleOf(isoRun(id))?.runId === isoRun(id)))
    check('two of those bubbles differ in the model alone, the third in the tool digests alone',
      modelDiff.join(',') === 'model' && toolDiff.join(',') === 'tools', `${modelDiff} / ${toolDiff}`)
    check('a rebuilt selector is another tool, by the digest of its bytes, and a run that used it says so',
      selectorRebuiltDigest !== selectorDigest && bubbleOf(isoRun('iso-c')).tools.some(tool => tool.implementationDigest === selectorRebuiltDigest) &&
      contextOf('iso-c') !== contextOf('iso-a'))
    check('everything but the context is identical across the three, so the context is the side that differs',
      ['iso-a', 'iso-b', 'iso-c'].every(id => isoA.denominator === measureStateOf(id).trials) &&
      new Set(['iso-a', 'iso-b', 'iso-c'].map(id => digestOf({ metric: measureStateOf(id).metric, weights: measureStateOf(id).weights, trials: measureStateOf(id).trials, judgement: measureStateOf(id).judgement }))).size === 1)
    check('each isolation candidate\'s numbers still came from its own two real trials',
      ['iso-a', 'iso-b', 'iso-c'].every(id => close(measureStateOf(id).observed.length, 2) && measureStateOf(id).observed.every(trial => trial.implementationDigest === meterDigest)))

    const poolTwo = async (roundId, round, left, right) => {
      await commands.openRound({
        commandId: nextId(`open-${roundId}`),
        roundId,
        round,
        incumbent: pinOf('r0002'),
        candidates: 2,
        explorationSlots: 0,
        historyCutoff: store.load().entries().length,
        caliber: caliberDigestOf(measureStateOf('iso-a')),
        metric: { direction: METRIC.direction },
        weights: WEIGHTS,
      })
      for (const [slot, side] of [left, right].entries())
        await commands.submitCandidate({
          commandId: nextId(`submit-${side.evaluationId}`),
          roundId,
          slot,
          revision: pinOf(side.revisionId),
          evaluationId: side.evaluationId,
          edits: [{ asset: 'skill', target: 'select-targets' }],
          exploratory: false,
        })
    }

    await poolTwo('round-iso-model', 3, { evaluationId: 'iso-a', revisionId: 'r0007' }, { evaluationId: 'iso-b', revisionId: 'r0008' })
    const modelClash = await asyncRefusalOf(() => commands.decideRound({ commandId: nextId('decide-iso-model'), roundId: 'round-iso-model' }))
    check('two candidates measured under different models are not pooled', modelClash.code === 'caliber-mismatch', modelClash.code)
    check('the refusal names both sides and both calibers',
      modelClash.detail.includes('slot 0') && modelClash.detail.includes('slot 1') && modelClash.detail.includes('iso-a') && modelClash.detail.includes('iso-b') && modelClash.detail.includes('may not be ranked together'),
      modelClash.detail)
    check('the refused round carries no decision fact', roundStateOf('round-iso-model').decision === undefined)
    const readClash = await asyncRefusalOf(() => projectRound(roundStateOf('round-iso-model'), sliceOf(store.load()), FLOOR))
    check('and the read projection refuses it too, before any decision is composed', readClash.code === 'caliber-mismatch', readClash.code)

    await poolTwo('round-iso-tool', 4, { evaluationId: 'iso-a', revisionId: 'r0007' }, { evaluationId: 'iso-c', revisionId: 'r0009' })
    const toolClash = await asyncRefusalOf(() => commands.decideRound({ commandId: nextId('decide-iso-tool'), roundId: 'round-iso-tool' }))
    check('two candidates whose runs used different tool builds are not pooled', toolClash.code === 'caliber-mismatch', toolClash.code)
    check('that refusal names the rebuilt-tool side too',
      toolClash.detail.includes('slot 0') && toolClash.detail.includes('slot 1') && toolClash.detail.includes('iso-c') && toolClash.detail.includes('may not be ranked together'),
      toolClash.detail)
    check('neither refused pool reached the log as a decided round', roundStateOf('round-iso-model').decision === undefined && roundStateOf('round-iso-tool').decision === undefined)

    // ---------------------------------------------------------------- 8. the cutoff does not move
    const republished = projectRound(roundStateOf('round-2'), sliceOf(store.load()), FLOOR)
    check('facts above the frozen cutoff do not move round two\'s decision', digestOf({ winner: republished.winner, outcomes: republished.outcomes }) === selectionDigest('round-2'))
    check('nor its frozen gain or novelty', close(republished.slots[0].gain, projectedTwo.slots[0].gain) && republished.slots[0].novelty === projectedTwo.slots[0].novelty)
    check('there are facts above that cutoff for the check to mean anything', store.load().entries().length > planTwo.historyCutoff, `${store.load().entries().length} vs ${planTwo.historyCutoff}`)

    // The number tracks the bytes: the same program over another method prints another number. This
    // measurement is deliberately not recorded — it is the probe's counterexample, not a fact.
    const original = await readFile(methodPathOf('r0001'), 'utf8')
    await writeFile(methodPathOf('r0001'), `${JSON.stringify({ words: REFERENCE.slice(0, 9) })}\n`, 'utf8')
    const swapped = await runMeasurement({
      metric: metric.measured,
      implementations: [meterImplementation],
      inputs: INPUTS,
      workspace,
      artifactPath: 'out/swapped.txt',
      command: `${shellLine([process.execPath, selectorRuntime, inputPath, join(workspace, 'out/swapped.txt'), methodPathOf('r0001'), marker, 'check:swap'])} && ${shellLine([
        process.execPath,
        meterProgram,
        join(workspace, 'out/swapped.txt'),
        referencePath,
        marker,
        'check:swap',
        'measure',
      ])}`,
      measure: realMeasurement(),
    })
    await writeFile(methodPathOf('r0001'), original, 'utf8')
    check('the same apparatus on other method bytes prints another number', swapped.kind === 'trial' && close(swapped.trial.quality, 0.9) && !close(swapped.trial.quality, 0.4), swapped.kind === 'trial' ? String(swapped.trial.quality) : swapped.reason)

    const counts = await markerCounts(marker)
    check('every recorded trial came from its own real invocation of the measurement program', counts.trials === trialsRecorded + missesRecorded && counts.trials === 20, `${counts.trials} runs, ${trialsRecorded} trials`)
    check('one planned slot produced no number, and it is recorded as a miss', missesRecorded === 1)
    check('the artifact digest of every recorded trial was verified against the bytes on disk', artifactsHashedAfterTheRun === 19, String(artifactsHashedAfterTheRun))
    check('the metric\'s selftest ran in both directions for every measurement', counts.samples === 2 * (counts.trials + counts.checks), `${counts.samples} sample runs for ${counts.trials + counts.checks} measurements`)
    check('the selector runtime ran once for every trial, in its own process', counts.selectors + counts.rebuilt.length === counts.trials + counts.checks, `${counts.selectors + counts.rebuilt.length} selector runs`)
    check('the rebuilt selector really produced the rebuilt-tool candidate\'s two artifacts', counts.rebuilt.join(',') === 'run:iso-c:0,run:iso-c:1', counts.rebuilt.join(','))
    check('the constraint program ran once per evaluation', counts.bounds === 10, String(counts.bounds))
    check('the counterexample measurement was measured but never recorded', !measureStateOf('r1-baseline').observed.some(trial => close(trial.quality, 0.9)))

    // ---------------------------------------------------------------- 9. replay from scratch
    console.log('\n== replay: every fact re-folded from the bytes on disk')
    const head = environmentOf().pointer
    const facts = store.load().entries().length
    const decisions = { 'round-1': selectionDigest('round-1'), 'round-2': selectionDigest('round-2') }
    const refolded = foldSubjects(registry, store.load().entries(), ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION).get(ENVIRONMENT)
    check('folding the same facts again yields the same head', refolded?.pointer === head, refolded?.pointer)

    await store.close()
    store = await ControlSessionStore.open({ persistence: live.persistence, controlId: CONTROL, registry, subjects, cwd: workspace })
    const reopened = store.load()
    check('the reopened store holds every committed fact', reopened.entries().length === facts, String(reopened.entries().length))
    check('the reopened store reads the same head from the same bytes', reopened.stateOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT)?.pointer === head)
    check('the reopened release state still carries its audit id', reopened.stateOf(RELEASE_PROTOCOL, RELEASE_VERSION, ENVIRONMENT)?.approvalId === grantedTwo.asked?.id)
    const replayedOne = projectRound(reopened.stateOf(STRATEGY_PROTOCOL, STRATEGY_VERSION, 'round-1'), sliceOf(reopened), FLOOR)
    const replayedTwo = projectRound(reopened.stateOf(STRATEGY_PROTOCOL, STRATEGY_VERSION, 'round-2'), sliceOf(reopened), FLOOR)
    check('replaying round one reproduces the same selection', digestOf({ winner: replayedOne.winner, outcomes: replayedOne.outcomes }) === decisions['round-1'])
    check('replaying round two reproduces the same selection', digestOf({ winner: replayedTwo.winner, outcomes: replayedTwo.outcomes }) === decisions['round-2'])

    answerer()
    const runStates = () => Object.values(store.load().stateOf(TASK_PROTOCOL, TASK_VERSION, TASK).runs)
    console.log('')
    console.log(`  facts ${facts}; checks ${checks}; refusals ${refusals}`)
    console.log(`  trials: real measurement runs ${counts.trials} (${missesRecorded} produced no number), selftest runs ${counts.samples}, artifacts hashed after the run ${artifactsHashedAfterTheRun}, constraint runs ${counts.bounds}, selector runs ${counts.selectors + counts.rebuilt.length}`)
    console.log(`  runs: ${runStates().length} runs, ${runStates().filter(run => run.bubble !== undefined).length} bubbles — 8 in the pooled context, 1 other model, 1 rebuilt selector`)
    console.log(`  round 1: winner slot ${decidedOne.winner} (quality ${good.quality.toFixed(4)}, gain ${good.gain === null ? 'null' : good.gain.toFixed(4)}) over slot 1 quality ${outOfBand.quality.toFixed(4)} refused as out of bounds; slot 2 denominator ${short.denominator}, observed ${incomplete.observed}, quality ${short.quality.toFixed(4)}, missing slot ${short.missingTrials[0]?.slot}`)
    console.log(`  round 2: winner slot ${decisionOf('round-2').winner} (quality ${novel.quality.toFixed(4)}, gain ${novel.gain.toFixed(4)}, novelty ${novel.novelty}) over slot 1 (quality ${known.quality.toFixed(4)}, novelty ${known.novelty}); incumbent ${incumbentQuality.toFixed(4)}`)
    console.log(`  release: head ${head}; pointer switches ${pointerFacts().length}; approvals recorded 2, asks refused stale 1`)
    console.log(`  isolation: 3 candidates in 3 runs pooled and decided (members differing: none); another model → ${modelClash.code} (differs: ${modelDiff.join(',')}), a rebuilt selector → ${toolClash.code} (differs: ${toolDiff.join(',')})`)
    console.log(`             "${modelClash.detail.split(';')[0]}"`)
    console.log(`             "${toolClash.detail.split(';')[0]}"`)
    console.log('  unobserved: no human decided anything — the grant comes from a probe-local answerer on the real request waterfall,')
    console.log('              and no UI answerer exists in this process; the method files and their numbers are probe-authored bytes,')
    console.log('              so "a real model improved" is not observed, only "the logged number came from a spawned program".')
    console.log('  unobserved: the round\'s winner was drafted by this probe, not by an automated consumer of the decision fact;')
    console.log('              the model identity in a bubble is a declaration this probe makes (its tools are programs it really runs).')

    if (failures.length > 0) {
      console.error(`\ncd-probe: ${failures.length} check(s) failed: ${failures.join(' | ')}`)
      process.exitCode = 1
    } else {
      console.log('\ncd-probe: OK — a real round of measured candidates, decided before any argmax by its hard constraints, and released through a native approval and a compare-and-swap')
    }
  } finally {
    try {
      await store.close()
    } catch {
      // The refusal is the outcome; a teardown failure must not replace it.
    }
    await Promise.all([handle?.dispose().catch(() => {}), ctx.fiber.dispose().catch(() => {}), rm(root, { recursive: true, force: true })])
  }
}

await main()

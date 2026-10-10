#!/usr/bin/env node
/**
 * F: one frozen domain task set, one same-caliber comparison, and the comparison's own aggregation.
 *
 * `cd-probe` shows a *revision* being measured, decided and published, and it does that inside the
 * product's own round protocol. F asks the last question of the old stack's replacement: **on a
 * frozen set of domain tasks, does the published method actually beat the baseline?** That is
 * forensics, not a mechanism, and this probe is deliberately built out of what already exists:
 *
 *   1. **The fixture is the comparison's identity.** `tests/fixtures/f-domain.json` holds the tasks
 *      (each with its own goal, inputs and criteria), the frozen caliber (`model`, tool digests,
 *      conditions, metric, judgement, weights, `trials` — the members a `measure@3` caliber already
 *      has), the frozen standards, and the **solve and holdout sets recorded separately**. Its
 *      canonical `digestOf` is printed; the comparison's identity is that digest together with the
 *      two revisions' content digests.
 *   2. **Every task really runs, twice, per side.** For each task and each side this probe opens a
 *      run (`task@5`), declares its bubble, opens a `measure@3` evaluation, and drives
 *      `src/measure/execution.ts` against `scripts/measure-runner.mjs`, which spawns two real
 *      programs per trial: the fixed selector applies the *revision's declared method* to the task's
 *      input, and the meter computes the number from the artifact. The number in the log is the one
 *      the meter printed.
 *   3. **The same question is asked twice.** Both sides declare a bubble carrying the fixture's
 *      model, tool digests, conditions and the task's inputs, and both evaluations freeze the
 *      fixture's metric, judgement, weights and `trials`. So `caliberDigestOf` must come out equal
 *      on the two sides — and equal to the caliber assembled from the fixture itself, so "same
 *      caliber" is a claim about the fixture and not a pair of evaluations agreeing with each other.
 *   4. **The comparison is the experiment's, not the product's.** Every aggregation below is this
 *      probe's own reading of two `EvaluationView`s and the frozen standards. The product has no
 *      projection that says "the published method won"; a cross-task reading is not an invariant of
 *      the log, and F adds none.
 *   5. **Below the bar reads as not having met it.** One task is additionally measured with a
 *      revision that is deliberately *worse* than the baseline. Its frozen gain is below
 *      `minQualityGain`, and this probe asserts that it reads as not having met the standard — a
 *      measured negative result, not a wiring claim (`review.md` §4 R09).
 *
 * **Holdout and solve are never pooled.** The two sets come out of the fixture as two lists, every
 * verdict names the set it belongs to, and the pooled numbers are computed per set. R08's rule is
 * why: data that has been fed back to the proposer has entered the search and may not be presented
 * as held-out evidence, so a reading that averaged the two would be a reading that lost that
 * distinction.
 *
 * **What is observed, and what is not.** The measurement *path* is real end to end — real processes,
 * real artifacts, the artifact hash taken after the run, the implementation resolved by the digest of
 * its bytes — but the method files the programs read are written by **this probe**, and the declared
 * model is a name this fixture carries, not a model that ran. So what is observed is "under one frozen
 * caliber, the number the fixture's published method produced beats the fixture's baseline method on
 * this frozen task set", and it is **not** observed that a real model improved. The real-model route
 * is `scripts/model-smoke.mjs`, deliberately not a gate because it needs network and credentials.
 * The behaviour regression half of F's exit condition is the four probes that already exist
 * (`control-probe`, `recovery-probe`, `slice-b`, `cd-probe`); F adds no regression mechanism.
 *
 * Run: node scripts/domain-probe.mjs
 *
 * @module singularity-core/scripts/domain-probe
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openPersistence } from './dsh-control-runtime.mjs'
import { digestOf } from '../src/protocol/envelope.ts'
import { foldSubjects } from '../src/protocol/fold.ts'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import { declareTaskProtocol, SCHEDULER_ROLE, TASK_PROTOCOL, TASK_VERSION, verifierRoleOf } from '../src/task/protocol.ts'
import { createMeasureCommands } from '../src/measure/commands.ts'
import { runMeasurement } from '../src/measure/execution.ts'
import { declareMeasureProtocol, contextDigestOf, MEASURE_PROTOCOL, MEASURE_VERSION } from '../src/measure/protocol.ts'
import { caliberDigestOf, projectEvaluation } from '../src/measure/view.ts'
import { runVerifierSelftest } from '../src/verifier/implementation.ts'
import { declareEnvironmentProtocol, ENVIRONMENT_PROTOCOL, ENVIRONMENT_ROLE, ENVIRONMENT_VERSION } from '../src/environment/protocol.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..')
const ADAPTER = join(HERE, 'measure-runner.mjs')
const FIXTURE_PATH = join(ROOT, 'tests', 'fixtures', 'f-domain.json')

/**
 * The fixture's canonical content digest, written down here by hand.
 *
 * It is a literal on purpose: printing the digest the probe just computed and calling it the
 * expected one is the tautology `docs/spec-policy.md` §1 forbids, and a fixture whose digest is not
 * pinned is not a frozen identity at all. This literal is recomputed by `node -e` from the file when
 * the fixture changes, and the check below fails until it is updated.
 */
const FROZEN_FIXTURE_DIGEST = '2284f3b8d3a470246c8099c7c45e923a63ec0cc854a34897bbc19fdafdb5336b'

const CONTROL = 'f-domain-probe'
const ENVIRONMENT = 'f-domain-library'
const AGENT = 'f-domain-agent'
const SELECTOR = 'selector'
const METER = 'meter'
const BOUNDS = 'bounds'
const MODEL = 'probe-authored/not-a-real-model'
const CONDITIONS = ['no-network']
const NOWHERE = 'the fixture carries no such member'

/** The words the probe plants. Targets are what a reference list names; fillers are what it does not. */
const TARGET = tag => index => `${tag}-t${index}`
const FILLER = tag => index => `${tag}-f${index}`

/** What the meter counts, and therefore what "quality" means here: the fixture's metric unit. */
const WORDS_OF = tag => ({ tag, targets: 4, fillers: 4 })

const failures = []
let checks = 0
function check(label, condition, detail) {
  checks += 1
  if (condition) console.log(`  ok    ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/**
 * Count the invocations each program logged for itself, by the label it appended to the marker file.
 *
 * This is the independent half of "there were real executions": the plan's numbers say what was
 * recorded, and this says what actually ran. `meter:run:<plan>:<slot>` is one real attempt.
 */
async function markerRuns(marker) {
  const text = await readFile(marker, 'utf8').catch(() => '')
  const lines = text.trim().split('\n').filter(Boolean)
  return {
    trials: lines.filter(entry => entry.startsWith('meter:run:')).length,
    selectors: lines.filter(entry => entry.startsWith('selector:')).length,
    bounds: lines.filter(entry => entry.startsWith('bounds:')).length,
  }
}
const close = (left, right) => Math.abs(left - right) < 1e-12

/** One process for real, without letting a non-zero exit throw. */
function runProcess(file, args) {
  return new Promise(resolve => {
    execFile(file, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr })
    })
  })
}

/** An argv as one shell line; every entry is quoted rather than pasted. */
const shellLine = argv => argv.map(entry => JSON.stringify(String(entry))).join(' ')

/** The fixed apparatus: one selector, one meter. The method they apply is the revision's. */
const SELECTOR_SOURCE = [
  "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'",
  'const [inputPath, artifactPath, methodPath, markerPath, label] = process.argv.slice(2)',
  'appendFileSync(markerPath, `selector:${label}\\n`)',
  "const words = readFileSync(inputPath, 'utf8').trim().split(/\\s+/).filter(Boolean)",
  "const method = JSON.parse(readFileSync(methodPath, 'utf8'))",
  "writeFileSync(artifactPath, words.filter(word => method.words.includes(word)).join(' '))",
].join('\n')

/** The meter is the implementation the fixture's metric names; `mode = fail` produces no number. */
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

/** The hard constraint the fixture's judgement names: no word outside the input may be selected. */
const BOUNDS_SOURCE = [
  "import { appendFileSync, readFileSync } from 'node:fs'",
  'const [artifactPath, inputPath, markerPath, label] = process.argv.slice(2)',
  'appendFileSync(markerPath, `bounds:${label}\\n`)',
  "const selected = readFileSync(artifactPath, 'utf8').trim().split(/\\s+/).filter(Boolean)",
  "const words = readFileSync(inputPath, 'utf8').trim().split(/\\s+/).filter(Boolean)",
  'process.exit(selected.every(word => words.includes(word)) ? 0 : 1)',
].join('\n')

/** The words of one task, as the probe plants them: targets first, then fillers, all distinct. */
function wordsOfTask(taskId, targets, fillers) {
  const tag = taskId
  return {
    targets: Array.from({ length: targets }, (_, index) => TARGET(tag)(index + 1)),
    fillers: Array.from({ length: fillers }, (_, index) => FILLER(tag)(index + 1)),
  }
}

/**
 * The methods, written as the method files the selector reads.
 *
 * The selector keeps the input words the method's own word list names, so what a method selects is
 * exactly the intersection of that list with the task's input. The three tags are therefore three
 * different selections over one input:
 *
 * - `mid` — the H0 baseline: one target word, so it recovers a quarter of the reference list.
 * - `strong` — the published method: every target word, so it recovers the reference list.
 * - `weak` — deliberately worse than the baseline: nothing at all.
 */
function methodWordsOf(tag, layout) {
  if (tag === 'mid') return [layout.targets[0]]
  if (tag === 'strong') return [...layout.targets, ...layout.fillers]
  return [] // `weak`: a method that selects nothing is below the baseline, not merely equal to it.
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
      implementationDigest: sha256(await readFile(meterProgram)),
      detail: reported.detail,
    }
  }
}

async function main() {
  const { ControlSessionStore } = await import('../src/control/session-store.ts')

  // ------------------------------------------------------------------ 0. the fixture, and its identity
  console.log('== the fixture: its content digest is this comparison\'s identity')
  const fixtureBytes = await readFile(FIXTURE_PATH, 'utf8')
  const fixture = JSON.parse(fixtureBytes)
  const { contentDigest: declared, ...body } = fixture
  const computedDigest = digestOf(body)

  check('the fixture declares the content digest of its own body, recomputed here', declared === computedDigest, `declared ${declared}, recomputed ${computedDigest}`)
  check('the fixture says "TBD" and the probe recomputes it', declared !== 'TBD', `declared ${declared}`)
  check('that recomputed digest is the one written down in this probe', computedDigest === FROZEN_FIXTURE_DIGEST, `recomputed ${computedDigest}, pinned ${FROZEN_FIXTURE_DIGEST}`)

  const solveSet = fixture.sets.solve
  const holdoutSet = fixture.sets.holdout
  const taskIds = fixture.tasks.map(task => task.taskId)
  check('solve and holdout are recorded separately, and neither is empty', solveSet.length > 0 && holdoutSet.length > 0)
  check('the two sets do not overlap and together are exactly the frozen task set',
    solveSet.every(id => !holdoutSet.includes(id)) && [...solveSet, ...holdoutSet].sort().join(',') === [...taskIds].sort().join(','),
    `solve ${solveSet.join(',')} / holdout ${holdoutSet.join(',')} / tasks ${taskIds.join(',')}`)

  const root = await mkdtemp(join(tmpdir(), 'singularity-domain-probe-'))
  const workspace = join(root, 'workspace')
  const sessions = join(root, 'sessions')
  await mkdir(join(workspace, 'in'), { recursive: true })
  await mkdir(join(workspace, 'out'), { recursive: true })
  await mkdir(sessions, { recursive: true })

  const marker = join(root, 'ran.log')
  meterProgram = join(root, 'meter.mjs')
  const boundsProgram = join(root, 'bounds.mjs')
  const selectorRuntime = join(root, 'selector-runtime.mjs')
  await writeFile(meterProgram, METER_SOURCE, 'utf8')
  await writeFile(boundsProgram, BOUNDS_SOURCE, 'utf8')
  await writeFile(selectorRuntime, SELECTOR_SOURCE, 'utf8')
  const meterDigest = sha256(await readFile(meterProgram))
  const boundsDigest = sha256(await readFile(boundsProgram))
  const selectorDigest = sha256(await readFile(selectorRuntime))

  // ------------------------------------------------------------- 1. the task set, planted and admitted
  console.log('\n== the frozen task set: inputs on disk, one admitted contract each')
  const layouts = {}
  const inputsOf = {}
  for (const task of fixture.tasks) {
    const layout = wordsOfTask(task.taskId, 4, 4)
    layouts[task.taskId] = layout
    const words = [...layout.targets, ...layout.fillers]
    const inputName = task.inputs[0]
    const referenceName = task.inputs[1]
    await mkdir(dirname(join(workspace, inputName)), { recursive: true })
    await writeFile(join(workspace, inputName), `${words.join(' ')}\n`, 'utf8')
    await writeFile(join(workspace, referenceName), `${layout.targets.join(' ')}\n`, 'utf8')
    inputsOf[task.taskId] = [
      { name: inputName, path: join(workspace, inputName), digest: sha256(await readFile(join(workspace, inputName))) },
      { name: referenceName, path: join(workspace, referenceName), digest: sha256(await readFile(join(workspace, referenceName))) },
    ]
  }
  const inputFiles = new Set()
  for (const task of fixture.tasks) for (const name of task.inputs) inputFiles.add(name)
  check('every task declares its own input and reference, and no two tasks share one file',
    inputFiles.size === fixture.tasks.length * 2, `${inputFiles.size} files for ${fixture.tasks.length} tasks`)

  /** One revision's method for one task, as real bytes on disk. */
  const methodPathOf = (revisionId, taskId) => join(workspace, 'methods', revisionId, `${taskId}.json`)
  const methodPaths = {}
  for (const side of ['baseline', 'published', 'below-bar']) {
    const revision = fixture.frozen.revisions[side]
    for (const [taskId, method] of Object.entries(revision.methods)) {
      methodPaths[`${side}:${taskId}`] = join(workspace, method.file)
      await mkdir(dirname(methodPaths[`${side}:${taskId}`]), { recursive: true })
      await writeFile(methodPaths[`${side}:${taskId}`], `${JSON.stringify({ words: methodWordsOf(method.tag, layouts[taskId]) })}\n`, 'utf8')
    }
  }
  check('every revision of the fixture has its method files on disk, each consumed by at least two tasks',
    Object.keys(methodPaths).length > 0 && fixture.frozen.revisions.published.methods['f-task-three'].tag === 'strong')

  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry)
  declareMeasureProtocol(registry)
  declareEnvironmentProtocol(registry)

  const subjects = {
    [SCHEDULER_ROLE]: 'scheduler-service',
    [verifierRoleOf({ verifierRef: METER, verifierVersion: '1' })]: 'meter-service',
    [verifierRoleOf({ verifierRef: BOUNDS, verifierVersion: '1' })]: 'bounds-service',
    [ENVIRONMENT_ROLE]: 'environment-service',
  }

  const live = await openPersistence(sessions)
  let store = await ControlSessionStore.open({ persistence: live.persistence, controlId: CONTROL, registry, subjects, cwd: workspace })
  let commandSeq = 0
  const nextId = prefix => `${prefix}-${(commandSeq += 1)}`

  try {
    const metric = {
      measured: { ...fixture.frozen.metric.measured, implementationDigest: meterDigest },
      unit: fixture.frozen.metric.unit,
      direction: fixture.frozen.metric.direction,
    }
    const judgement = fixture.frozen.judgement.map(criterion => ({ ...criterion, implementationDigest: boundsDigest }))
    const measure = createMeasureCommands({
      store,
      registry,
      implementations: [
        { ref: METER, version: '1', implementationDigest: meterDigest },
        { ref: BOUNDS, version: '1', implementationDigest: boundsDigest },
      ],
    })

    const environmentOf = () => store.load().stateOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT)
    const evaluationOf = evaluationId => store.load().stateOf(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)
    const taskOf = taskId => store.load().stateOf(TASK_PROTOCOL, TASK_VERSION, taskId)

    // ----------------------------------------------------------- 2. revisions, tasks, runs and bubbles
    for (const [side, revision] of Object.entries(fixture.frozen.revisions)) {
      const perTask = Object.fromEntries(
        await Promise.all(
          Object.entries(revision.methods).map(async ([taskId, method]) => [taskId, { file: method.file, words: methodWordsOf(method.tag, layouts[taskId]).length, digest: sha256(await readFile(methodPaths[`${side}:${taskId}`])) }]),
        ),
      )
      await store.emit({
        commandId: nextId(`create-${revision.revisionId}`),
        protocol: ENVIRONMENT_PROTOCOL,
        version: ENVIRONMENT_VERSION,
        kind: 'revision/created',
        subject: ENVIRONMENT,
        payload: { revisionId: revision.revisionId, manifest: { skills: ['select-targets'], taskTemplates: [], methods: perTask } },
      })
    }
    const pinOf = side => {
      const revisionId = fixture.frozen.revisions[side].revisionId
      return { environmentId: ENVIRONMENT, revisionId, digest: environmentOf().revisions[revisionId].contentDigest }
    }
    const methodBytesHold = []
    for (const side of ['baseline', 'published', 'below-bar'])
      for (const taskId of Object.keys(fixture.frozen.revisions[side].methods))
        methodBytesHold.push(
          environmentOf().revisions[fixture.frozen.revisions[side].revisionId].manifest.methods[taskId].digest ===
            sha256(await readFile(methodPaths[`${side}:${taskId}`])),
        )
    check('every revision declares, and the log holds, the digest of its method bytes on disk', methodBytesHold.every(Boolean))

    // One task subject per fixture task, each with its own admitted contract and its own responsible
    // agent: the fixture's tasks are three tasks, not three runs of one.
    for (const task of fixture.tasks) {
      const admitted = task.criteria.map(criterion => ({ ...criterion, implementationDigest: meterDigest }))
      await store.emit({
        commandId: nextId(`admit-${task.taskId}`),
        protocol: TASK_PROTOCOL,
        version: TASK_VERSION,
        kind: 'task/admitted',
        subject: task.taskId,
        payload: { contract: { goal: task.goal, inputs: task.inputs, criteria: admitted } },
      })
      await store.emit({
        commandId: nextId(`assign-${task.taskId}`),
        protocol: TASK_PROTOCOL,
        version: TASK_VERSION,
        kind: 'task/assigned',
        subject: task.taskId,
        payload: { agentId: AGENT, agentIdentity: subjects[SCHEDULER_ROLE] },
      })
    }
    check('each fixture task is its own subject with its own contract, and each run is answerable',
      fixture.tasks.length === 3 &&
        fixture.tasks.every(task => taskOf(task.taskId)?.contract?.goal === task.goal && taskOf(task.taskId)?.responsibility?.agentIdentity === subjects[SCHEDULER_ROLE]))

    // The bubble every evaluation of every side declares: the fixture's frozen apparatus plus the
    // task's own inputs. Both sides of one task declare exactly this, which is what makes them two
    // answers to one question rather than two experiments.
    const frozenTools = [
      { name: SELECTOR, implementationDigest: selectorDigest, version: '1' },
      { name: METER, implementationDigest: meterDigest, version: '1' },
    ]
    const bubbleOfTask = taskId => ({
      model: MODEL,
      tools: frozenTools,
      conditions: CONDITIONS,
      inputs: inputsOf[taskId].map(input => ({ name: input.name, digest: input.digest })),
    })

    const beginRun = async (taskId, runId, side) => {
      await store.emit({
        commandId: nextId(`start-${runId}`),
        protocol: TASK_PROTOCOL,
        version: TASK_VERSION,
        kind: 'run/started',
        subject: taskId,
        payload: { runId, revision: pinOf(side) },
      })
      await store.emit({
        commandId: nextId(`bubble-${runId}`),
        protocol: TASK_PROTOCOL,
        version: TASK_VERSION,
        kind: 'bubble/opened',
        subject: taskId,
        payload: { runId, workspace: { kind: 'dir', ref: workspace }, ...bubbleOfTask(taskId) },
      })
    }

    // The meter's selftest, in both directions, on real artifacts: a gate that has never failed is
    // not known to work.
    const cleanSample = join(root, 'clean-sample.txt')
    const emptySample = join(root, 'empty-sample.txt')
    await writeFile(cleanSample, layouts['f-task-one'].targets.join(' '), 'utf8')
    await writeFile(emptySample, '', 'utf8')
    const meterImplementation = {
      ref: METER,
      version: '1',
      implementationDigest: meterDigest,
      selftest: {
        samples: [
          { name: 'measures a selection', expected: 'pass', input: { subject: cleanSample, artifactDigest: sha256('clean'), inputs: [] } },
          { name: 'produces no number for a failed run', expected: 'fail', input: { subject: emptySample, artifactDigest: sha256('empty'), inputs: [] } },
        ],
      },
      judge: async sample => {
        const ran = await runProcess(process.execPath, [meterProgram, sample.subject, join(workspace, inputsOf['f-task-one'][1].name), marker, 'sample', sample.subject === cleanSample ? 'measure' : 'fail'])
        return { verdict: ran.code === 0 ? 'pass' : 'fail' }
      },
    }
    const boundsImplementation = {
      ref: BOUNDS,
      version: '1',
      implementationDigest: boundsDigest,
      selftest: {
        samples: [
          { name: 'passes a selection inside the input', expected: 'pass', input: { subject: cleanSample, artifactDigest: sha256('clean'), inputs: [] } },
          { name: 'fails a selection naming no input word', expected: 'fail', input: { subject: emptySample, artifactDigest: sha256('empty'), inputs: [] } },
        ],
      },
      judge: async sample => {
        const ran = await runProcess(process.execPath, [boundsProgram, sample.subject, join(workspace, inputsOf['f-task-one'][0].name), marker, 'sample'])
        return { verdict: ran.code === 0 ? 'pass' : 'fail' }
      },
    }
    const selftest = await runVerifierSelftest(meterImplementation)
    check('the metric\'s program produces both verdicts on real samples', selftest.ran === 2 && selftest.failures.length === 0, JSON.stringify(selftest.failures))

    // --------------------------------------------------------------------- 3. measuring one side
    /**
     * Measure one (task, side) pair for real: one run, one bubble, one `measure@3` plan, `trials`
     * real executions recorded as observations or as explicitly declared misses.
     *
     * `baseline` is the pin the plan compares against, and it is the fixture's H0 revision on both
     * sides: every number is read as a delta against the same incumbent.
     */
    const measureSide = async (taskId, side, planId, modes, baselineSide) => {
      const runId = `run-${planId}`
      const before = (await readFile(marker, 'utf8').catch(() => '')).split('\n').filter(l => l.startsWith('meter:run')).length
      await beginRun(taskId, runId, side)
      await measure.openEvaluation({
        commandId: nextId(`open-${planId}`),
        evaluationId: planId,
        baseline: pinOf(baselineSide),
        candidate: pinOf(side),
        run: { taskId, runId },
        metric,
        weights: fixture.frozen.weights,
        trials: fixture.frozen.trials,
        judgement,
      })
      const paths = {
        input: join(workspace, inputsOf[taskId][0].name),
        reference: join(workspace, inputsOf[taskId][1].name),
        method: methodPaths[`${side}:${taskId}`],
      }
      const artifactsHashed = []
      for (const [slot, mode] of modes.entries()) {
        const artifactName = `out/${planId}-${slot}.txt`
        const artifactPath = join(workspace, artifactName)
        const label = `run:${planId}:${slot}`
        const outcome = await runMeasurement({
          metric: metric.measured,
          implementations: [meterImplementation],
          inputs: inputsOf[taskId].map(input => ({ name: input.name, digest: input.digest })),
          workspace,
          artifactPath: artifactName,
          command: `${shellLine([process.execPath, selectorRuntime, paths.input, artifactPath, paths.method, marker, label])} && ${shellLine([
            process.execPath,
            meterProgram,
            artifactPath,
            paths.reference,
            marker,
            label,
            mode,
          ])}`,
          measure: realMeasurement(),
        })
        if (outcome.kind === 'missed') {
          await measure.missTrial({ commandId: nextId(`miss-${planId}-${slot}`), evaluationId: planId, slot, reason: outcome.reason })
          continue
        }
        if (sha256(await readFile(artifactPath)) === outcome.trial.artifactDigest) artifactsHashed.push(slot)
        await measure.recordTrial({ commandId: nextId(`trial-${planId}-${slot}`), evaluationId: planId, trial: { slot, ...outcome.trial } })
      }
      const observation = evaluationOf(planId).observed[0]
      const boundsRan = await runProcess(process.execPath, [boundsProgram, join(workspace, `out/${planId}-0.txt`), paths.input, marker, planId])
      await measure.checkConstraint({
        commandId: nextId(`check-${planId}`),
        evaluationId: planId,
        criterionId: 'bounded',
        met: boundsRan.code === 0,
        artifactDigest: observation.artifactDigest,
        implementationDigest: boundsDigest,
      })
      return { planId, taskId, side, runId, artifactsHashed }
    }

    // -------------------------------------------------- 4. the two sides of every frozen task
    console.log('\n== two sides, one question: the same task measured against H0 and against the published method')
    const modesOf = (taskId, side) => (side === 'published' && taskId === holdoutSet[0] ? ['measure', 'fail'] : ['measure', 'measure'])
    check('the planted miss really is planted: the holdout\'s published side plans one producing run and one that produces no number',
      modesOf(holdoutSet[0], 'published').join(',') === 'measure,fail' && modesOf(solveSet[0], 'published').join(',') === 'measure,measure')
    // The task the deliberately-below-bar revision is measured on: a solve task, so the negative
    // result is stated about the same set everything else is stated about.
    const belowBarTask = solveSet[1]
    const measured = []
    for (const taskId of taskIds) {
      for (const side of ['baseline', 'published']) {
        const planId = `${taskId}-${side}`
        measured.push(await measureSide(taskId, side, planId, modesOf(taskId, side), 'baseline'))
      }
    }
    measured.push(await measureSide(belowBarTask, 'below-bar', `${belowBarTask}-below-bar`, ['measure', 'measure'], 'baseline'))

    /**
     * Every plan the aggregation reads, projected from the log rather than remembered from the loop
     * above: the baseline side of the below-bar task, for instance, is the same H0 plan every other
     * verdict reads and is not measured a second time just to be named here.
     */
    const viewOf = planId => projectEvaluation(evaluationOf(planId))
    const planIds = taskIds.flatMap(taskId => [`${taskId}-baseline`, `${taskId}-published`]).concat([`${belowBarTask}-below-bar`])
    const views = Object.fromEntries(planIds.map(planId => [planId, viewOf(planId)]))
    check('every plan the comparison reads is one the probe opened, and it reads nothing else',
      planIds.length === measured.length && planIds.every(planId => evaluationOf(planId)?.trials === fixture.frozen.trials),
      `${planIds.length} plans for ${measured.length} measured`)
    const caliberOfPlan = planId => caliberDigestOf(evaluationOf(planId))
    /**
     * The caliber the fixture froze, assembled here **from the fixture** and from nothing the probe
     * worked out along the way.
     *
     * The frozen members are the fixture's own values, and the context digest is recomputed from the
     * fixture's declared model, conditions and per-task inputs (the tool digests are the bytes on
     * disk, because the fixture freezes the tool *names* it expects to be run under — see
     * `docs/f-evidence.md`). If the evaluations were opened under some other question, this is where
     * it shows: "same caliber" has to mean the fixture's caliber, or it only means "these two agree
     * with each other".
     */
    const frozenCaliberInputs = taskId =>
      digestOf({
        context: contextDigestOf({
          model: fixture.frozen.model,
          tools: frozenTools,
          conditions: fixture.frozen.conditions,
          inputs: inputsOf[taskId].map(input => ({ name: input.name, digest: input.digest })),
        }),
        metric,
        weights: fixture.frozen.weights,
        trials: fixture.frozen.trials,
        judgement,
      })
    /** The fixture's caliber for each task, by the plan id that must reproduce it. */
    const caliberByName = Object.fromEntries(taskIds.map(taskId => [`${taskId}-baseline`, frozenCaliberInputs(taskId)]))

    // Assertion 1: both sides' evaluations are opened and their calibers are equal — and equal to
    // the fixture's own, and different from the unopened measurement's (which is comparable with
    // nothing, not "equal because both are missing").
    check('both sides\' evaluations are open for every task, and every one of them carries a caliber',
      taskIds.every(taskId => caliberOfPlan(`${taskId}-baseline`) !== undefined && caliberOfPlan(`${taskId}-published`) !== undefined))
    check('the two sides of every task freeze one caliber, digit for digit',
      taskIds.every(taskId => caliberOfPlan(`${taskId}-baseline`) === caliberOfPlan(`${taskId}-published`)))
    check('that caliber is the one the fixture froze, task by task and not merely a pair of evaluations agreeing',
      taskIds.every(taskId => caliberOfPlan(`${taskId}-baseline`) === frozenCaliberInputs(taskId) && caliberOfPlan(`${taskId}-published`) === frozenCaliberInputs(taskId)),
      taskIds.map(taskId => `${taskId} ${caliberOfPlan(`${taskId}-baseline`)?.slice(0, 12)} vs fixture ${frozenCaliberInputs(taskId).slice(0, 12)}`).join('; '))
    check('a measurement that was never opened is comparable with nothing, not equal to another gap',
      caliberDigestOf({ evaluationId: 'never-opened', observed: [], missed: [], checks: [] }) === undefined && caliberOfPlan(`${taskIds[0]}-baseline`) !== undefined)
    // The check above is only worth making if the digest it compares really is a function of the
    // fixture's frozen members: re-deriving it with one member moved must land somewhere else.
    check('the fixture\'s caliber digest is a function of the fixture: move one frozen member and it moves',
      frozenCaliberInputs(taskIds[0]) !== digestOf({
        context: contextDigestOf({ model: fixture.frozen.model, tools: frozenTools, conditions: fixture.frozen.conditions, inputs: inputsOf[taskIds[0]].map(input => ({ name: input.name, digest: input.digest })) }),
        metric,
        weights: { quality: fixture.frozen.weights.quality, cost: fixture.frozen.weights.cost + 1 },
        trials: fixture.frozen.trials,
        judgement,
      }))

    /** One side's bubble, read back from the run the evaluation names rather than remembered here. */
    const bubbleOf = (planId, taskId) => taskOf(taskId).runs[evaluationOf(planId).run.runId]?.bubble
    check('every task and side ran in a run of its own, each with the bubble it declared',
      measured.every(entry => bubbleOf(entry.planId, entry.taskId)?.runId === entry.runId) &&
        new Set(measured.map(entry => `${entry.taskId}/${entry.runId}`)).size === measured.length)
    check('the two sides of one task declare one execution context: the same model, tools, conditions and inputs',
      taskIds.every(taskId => {
        const left = bubbleOf(`${taskId}-baseline`, taskId)
        const right = bubbleOf(`${taskId}-published`, taskId)
        return left !== undefined && right !== undefined &&
          contextDigestOf(left) === contextDigestOf(right) &&
          digestOf(left) !== digestOf(right) // the run ids and workspaces do differ; those are not the question
      }))

    // Assertion 2: `trials` real executions per side, and a missing one is represented explicitly.
    const sideReport = planId => {
      const view = views[planId]
      return {
        planId,
        observed: view.observed,
        denominator: view.denominator,
        missingSlots: view.missing.map(slot => slot.slot),
        quality: view.quality,
        // `cost` sums the observations, so it grows with the trial count. The standard is about the
        // price of one attempt, so what is compared is the mean — otherwise raising `trials` would
        // move a cost ceiling nobody moved.
        costPerTrial: view.cost === null || view.observed === 0 ? null : view.cost / view.observed,
        admissible: view.admissible,
        why: view.why,
        checks: view.constraints.map(constraint => constraint.met),
      }
    }

    // Every planned slot is either an observation or a declared miss, on both sides of every task.
    const claims = measured.map(entry => {
      const view = views[entry.planId]
      return {
        planId: entry.planId,
        trials: evaluationOf(entry.planId).trials,
        observed: view.observed,
        denominator: view.denominator,
        missing: view.missing.map(slot => slot.slot),
        admissible: view.admissible,
        why: view.why,
      }
    })
    const claimOf = planId => claims.find(claim => claim.planId === planId)
    check('every task and side carries the fixture\'s trial count of real executions',
      claims.every(claim => claim.denominator === fixture.frozen.trials) &&
        claims.every(claim => claim.observed === fixture.frozen.trials || claim.observed + claim.missing.length === claim.denominator) &&
        claims.filter(claim => claim.observed === fixture.frozen.trials).length === measured.length - 1,
      JSON.stringify(claims.map(claim => [claim.planId, claim.observed, claim.denominator])))
    check('the side that is short a trial has one declared miss, named by slot and by reason',
      claimOf(`${holdoutSet[0]}-published`).observed === 1 &&
        claimOf(`${holdoutSet[0]}-published`).missing.length === 1 &&
        claimOf(`${holdoutSet[0]}-published`).missing[0] === 1 &&
        evaluationOf(`${holdoutSet[0]}-published`).missed[0].reason.includes('exited 3'),
      JSON.stringify(evaluationOf(`${holdoutSet[0]}-published`).missed.map(entry => [entry.slot, entry.reason])))
    // The accounting, read on the fixture's own claims and on a control that is deliberately one
    // slot short: an arithmetic only ever applied to rows that balance is an arithmetic whose
    // answer is a constant, so the control is what makes "a slot is missing" a fact this can say.
    const shortControl = { planId: 'control-one-slot-short', observed: 1, missing: [1], denominator: 3 }
    const accounts = claim => claim.observed + claim.missing.length === claim.denominator
    // The answer is read from one plan that balances, the one that is short, and a control that is
    // short by construction: a rule only ever shown a balanced row is a rule that always says yes.
    const accountsFor = [claims[0], claimOf(`${holdoutSet[0]}-published`), shortControl].map(accounts)
    check('no slot anywhere is silently absent: each one is an observation or a named miss',
      JSON.stringify(accountsFor) === JSON.stringify([true, false, false]) && claims.filter(claim => claim.missing.length > 0).length === 1,
      JSON.stringify(claims.map(claim => [claim.planId, claim.observed, claim.missing.length, claim.denominator])))
    check('the slot the plan left empty is the reason the candidate is inadmissible, not a score',
      claimOf(`${holdoutSet[0]}-published`).admissible === false &&
        views[`${holdoutSet[0]}-published`].missing[0].slot === 1 &&
        (claimOf(`${holdoutSet[0]}-published`).why ?? '').includes('slot 1'),
      claimOf(`${holdoutSet[0]}-published`).why)
    const ran = await markerRuns(marker)
    // The attempt is what the program logged, and one of them produced no number: it appended its
    // marker and exited 3 before printing one, which is why the count of attempts is the plan's and
    // the count of observations is one lower.
    check('the measurement program was attempted once for every planned slot, and one attempt produced no number',
      ran.trials === measured.length * fixture.frozen.trials &&
        ran.selectors === ran.trials &&
        ran.bounds === measured.length &&
        claims.reduce((total, claim) => total + claim.observed, 0) === ran.trials - 1,
      JSON.stringify(ran))
    check('every number a slot carries came from the metric\'s implementation, from bytes on disk',
      measured.every(entry => entry.artifactsHashed.length === evaluationOf(entry.planId).observed.length) &&
        evaluationOf(`${taskIds[0]}-baseline`).observed.every(trial => trial.implementationDigest === meterDigest))

    // Assertion 4's other half: the fixture's own numbers, by hand, are what the real runs produced.
    const hand = {
      'f-task-one': { baseline: 0.25, published: 1.0 },
      'f-task-two': { baseline: 0.25, published: 1.0 },
      'f-task-three': { baseline: 0.25, published: 0.5 },
    }
    check('the measured quality is the hand-computed value of the fixture\'s own layout',
      taskIds.every(taskId => close(views[`${taskId}-baseline`].quality, hand[taskId].baseline) && close(views[`${taskId}-published`].quality, hand[taskId].published)),
      taskIds.map(taskId => `${taskId} ${views[`${taskId}-baseline`].quality}/${views[`${taskId}-published`].quality} vs ${hand[taskId].baseline}/${hand[taskId].published}`).join('; '))

    // ------------------------------------------------- 5. the aggregation, and the frozen standards
    console.log('\n== the comparison: the probe aggregates, the fixture\'s standards decide')
    const standards = fixture.frozen.standards ?? fixture.standards
    const setOf = taskId => (holdoutSet.includes(taskId) ? 'holdout' : 'solve')

    /**
     * One task's verdict, as this probe reads it: both sides' aggregates, the delta, and whether the
     * fixture's standards say the bar was met.
     *
     * `worstCaseGain` is the honest floor rather than the point estimate. `quality` is
     * `observed / denominator`, so an incomplete candidate has already been charged for its missing
     * slot; the floor charges it once more and then requires *that* number to clear the bar, so a
     * comparison cannot clear `minQualityGain` on the strength of a planned trial nobody ran. The
     * cost standard is a ceiling, so a side with an unknown cost cannot be shown to be inside it: an
     * unknown cost reads as not met, exactly as `projectEvaluation` refuses to turn one into 0.
     */
    const verdictOf = (label, candidateSide, taskId, bars) => {
      const baseline = sideReport(`${taskId}-baseline`)
      const candidate = sideReport(`${taskId}-${candidateSide}`)
      const gain = candidate.quality - baseline.quality
      const missingShare = candidate.denominator === 0 ? 0 : (candidate.denominator - candidate.observed) / candidate.denominator
      const worstCaseGain = gain - missingShare
      const complete = candidate.observed === candidate.denominator && baseline.observed === baseline.denominator
      const costsKnown = candidate.costPerTrial !== null && baseline.costPerTrial !== null
      const withinCost = costsKnown && candidate.costPerTrial - baseline.costPerTrial <= bars.maxCostIncrease
      const met = complete && worstCaseGain > bars.minQualityGain && withinCost
      return {
        label,
        taskId,
        bars,
        set: setOf(taskId),
        baseline: baseline.quality,
        candidate: candidate.quality,
        gain,
        worstCaseGain,
        complete,
        costsKnown,
        costPerTrial: [baseline.costPerTrial, candidate.costPerTrial],
        met,
        candidateChecks: candidate.checks,
        baselineChecks: baseline.checks,
      }
    }

    const verdictsOf = (label, pairs, bars = standards) => pairs.map(([taskId, candidateSide]) => verdictOf(label, candidateSide, taskId, bars))
    /** A control reads the same runs: a standard may change a verdict, never a measurement. */
    const standardGainUnchanged = verdicts =>
      verdicts.every(verdict => close(verdict.gain, comparison.solve.find(solve => solve.taskId === verdict.taskId).gain))
    const aggregateOf = verdicts => ({
      tasks: verdicts.length,
      quality: verdicts.reduce((total, verdict) => total + verdict.candidate, 0) / verdicts.length,
      baseline: verdicts.reduce((total, verdict) => total + verdict.baseline, 0) / verdicts.length,
      gain: verdicts.reduce((total, verdict) => total + verdict.gain, 0) / verdicts.length,
      worstCaseGain: verdicts.reduce((total, verdict) => total + verdict.worstCaseGain, 0) / verdicts.length,
      complete: verdicts.every(verdict => verdict.complete),
      met: verdicts.every(verdict => verdict.met),
    })

    // The comparison F exists to make: the published method against H0, on the solve set and on the
    // holdout set, each recorded on its own and never averaged together.
    const comparison = {
      solve: verdictsOf('solve', solveSet.map(taskId => [taskId, 'published'])),
      holdout: verdictsOf('holdout', holdoutSet.map(taskId => [taskId, 'published'])),
      belowBar: verdictsOf('below-bar', [[belowBarTask, 'below-bar']]),
    }
    // The declared model is the fixture's, not a model that ran: this is the ledger of what was
    // measured. A task measured by the below-bar revision is in it — data handed to the comparison
    // is no longer held out.
    const ledger = { measured: measured.map(entry => ({ planId: entry.planId, taskId: entry.taskId, side: entry.side, set: setOf(entry.taskId) })) }

    check('every task in the fixture has both sides aggregated, and the ledger names every one of them',
      taskIds.every(taskId => comparison.solve.concat(comparison.holdout).some(verdict => verdict.taskId === taskId)) &&
        ledger.measured.length === taskIds.length * 2 + 1,
      `ledger ${ledger.measured.length} for ${taskIds.length} tasks`)
    const solveAggregate = aggregateOf(comparison.solve)
    const holdoutAggregate = aggregateOf(comparison.holdout)
    const everyVerdict = [...comparison.solve, ...comparison.holdout]
    const pooled = aggregateOf(everyVerdict)
    check('the two sets are separate readings, never pooled into one number',
      comparison.solve.every(verdict => verdict.set === 'solve') &&
        comparison.holdout.every(verdict => verdict.set === 'holdout') &&
        comparison.solve.length === solveSet.length &&
        comparison.holdout.length === holdoutSet.length,
      `solve ${comparison.solve.length} / holdout ${comparison.holdout.length}`)
    // The control: what a pooled reading would have said. If the two sets were ever averaged, the
    // number would be this one and neither of the two readings below.
    check('a pooled reading of the two sets is a different number from either of them',
      close(pooled.gain, (solveAggregate.gain * solveSet.length + holdoutAggregate.gain * holdoutSet.length) / everyVerdict.length) &&
        close(pooled.quality, (solveAggregate.quality * solveSet.length + holdoutAggregate.quality * holdoutSet.length) / everyVerdict.length) &&
        !close(pooled.gain, solveAggregate.gain) && !close(pooled.gain, holdoutAggregate.gain) &&
        !close(pooled.quality, holdoutAggregate.quality),
      `pooled gain ${pooled.gain}, pooled quality ${pooled.quality}`)

    check('the published method beats H0 on the solve set by the hand-computed margin',
      close(solveAggregate.gain, 0.75) && close(solveAggregate.baseline, 0.25) && close(solveAggregate.quality, 1.0),
      `gain ${solveAggregate.gain}`)
    check('the solve set meets the fixture\'s frozen standard on quality and stays inside its cost ceiling',
      solveAggregate.met === true && solveAggregate.worstCaseGain > standards.minQualityGain &&
        comparison.solve.every(verdict => verdict.costPerTrial[1] - verdict.costPerTrial[0] <= standards.maxCostIncrease),
      JSON.stringify({ gain: solveAggregate.gain, worstCaseGain: solveAggregate.worstCaseGain, costs: comparison.solve.map(verdict => verdict.costPerTrial) }))
    // One observation of 1.0 against a denominator of 2: the run was perfect and the reading is a
    // half, which is the truthful direction for an incomplete measurement.
    check('the holdout set is reported as its own number, and it is the number its own trials support',
      close(holdoutAggregate.gain, 0.25) && close(holdoutAggregate.quality, 0.5) &&
        holdoutAggregate.baseline === 0.25 && holdoutAggregate.complete === false,
      `holdout gain ${holdoutAggregate.gain}, quality ${holdoutAggregate.quality}, complete ${holdoutAggregate.complete}`)
    check('a holdout reading that is below the bar reads as not having met it, not as "wired up"',
      holdoutAggregate.met === false && comparison.holdout.every(verdict => verdict.met === false))
    check('the same frozen standard is met on the solve set and not on the holdout set',
      solveAggregate.met === true && holdoutAggregate.met === false)
    // The cost ceiling and the missing-slot floor are both terms of `met`, and on a solve set that
    // clears both they would be terms nobody could see. So each is read once where it decides:
    // the same measurements under a ceiling of zero, and the holdout's gain against a bar its own
    // missing trial would have cleared.
    const noCostRoom = verdictsOf('solve+no-cost-room', solveSet.map(taskId => [taskId, 'published']), { ...standards, maxCostIncrease: 0 })
    check('the cost ceiling is load-bearing: under a ceiling of zero the same comparison does not meet the bar',
      noCostRoom.every(verdict => verdict.met === false) &&
        noCostRoom.every(verdict => verdict.quality === comparison.solve.find(solve => solve.taskId === verdict.taskId).quality) &&
        standardGainUnchanged(noCostRoom),
      JSON.stringify(noCostRoom.map(verdict => [verdict.taskId, verdict.met, verdict.gain])))
    // The same question for the missing slot. The holdout side produced one of its two planned trials,
    // so `quality` already carries half a slot's worth of nothing. What the floor adds is the second
    // half — the part that says an unrun slot may not be read as an unremarkable one — and the point
    // of the two numbers below is that without it the same run would read as clearing the bar.
    check('the missing-slot floor is load-bearing: the empty slot takes half the reported gain back',
      comparison.holdout.every(verdict => close(verdict.gain, holdoutAggregate.gain)) &&
        comparison.holdout.every(verdict => close(verdict.worstCaseGain, holdoutAggregate.gain - 0.5)) &&
        comparison.holdout.every(verdict => close(verdict.gain - verdict.worstCaseGain, 0.5)) &&
        comparison.holdout.every(verdict => verdict.met === false) &&
        comparison.holdout.every(verdict => verdict.gain > 0),
      JSON.stringify(comparison.holdout.map(verdict => [verdict.gain, verdict.worstCaseGain, verdict.met])))
    check('the bar is the fixture\'s frozen standard, not a number this probe chose',
      standards.minQualityGain === 0.1 && standards.maxCostIncrease === 0.15 &&
        JSON.stringify(comparison.solve.map(verdict => verdict.bars)) === JSON.stringify([standards, standards]))
    // The same measurements read against a harder quality bar. Nothing about the runs changes; only
    // the standard does, and the verdict has to follow it.
    const harderBar = { ...standards, minQualityGain: solveAggregate.gain }
    const underHarderBar = verdictsOf('solve+harder-bar', solveSet.map(taskId => [taskId, 'published']), harderBar)
    check('raising the quality bar over the same measurements turns "met" into "not met"',
      underHarderBar.every(verdict => verdict.met === false) &&
        aggregateOf(underHarderBar).gain === solveAggregate.gain &&
        JSON.stringify(underHarderBar.map(verdict => verdict.candidate)) === JSON.stringify(comparison.solve.map(verdict => verdict.candidate)),
      JSON.stringify(underHarderBar.map(verdict => [verdict.gain, verdict.met])))

    // The deliberately-below-bar measurement: a candidate that is not better than its baseline. Its
    // verdict must read as not met, and it must not be rescued by being "measured at all".
    const belowBarVerdict = comparison.belowBar[0]
    check('a candidate measured to be worse than H0 reads as below the bar', belowBarVerdict.gain < 0 && belowBarVerdict.met === false, `gain ${belowBarVerdict.gain}`)
    check('that verdict is complete and admissible, so "not met" is about the standard and not about a missing trial',
      belowBarVerdict.complete === true && views[`${belowBarTask}-below-bar`].admissible === true, belowBarVerdict.complete ? '' : 'incomplete')
    check('the below-bar side was measured under the same caliber as the two sides it is compared against',
      caliberOfPlan(`${belowBarTask}-below-bar`) === caliberByName[`${belowBarTask}-baseline`])
    check('every hard constraint of every evaluation was checked by its own implementation and met',
      measured.every(entry => evaluationOf(entry.planId).checks.length === judgement.length && evaluationOf(entry.planId).checks.every(check => check.met === true)),
      JSON.stringify(measured.map(entry => evaluationOf(entry.planId).checks.map(check => check.met))))

    // Assertion 5: the conclusion's inputs are frozen identities, and replaying the same cutoff
    // reproduces the same conclusion.
    const conclusionInputOf = () => ({
      fixture: computedDigest,
      baseline: pinOf('baseline').digest,
      published: pinOf('published').digest,
      standards: fixture.standards,
    })
    const digestOfConclusion = value =>
      digestOf({ input: conclusionInputOf(), solve: value.solve.map(verdict => [verdict.taskId, verdict.gain, verdict.met]), holdout: value.holdout.map(verdict => [verdict.taskId, verdict.gain, verdict.met]) })
    const conclusion = digestOfConclusion(comparison)
    check('the two revisions the conclusion is about are two different contents',
      conclusionInputOf().baseline !== conclusionInputOf().published)
    // The identity is recomputed here from the frozen input and the verdicts by hand, so what it
    // covers is a fact about the conclusion and not a fact about `digestOfConclusion` agreeing with
    // itself: dropping a member of `value` from the digest below changes this number.
    const handBuiltConclusion = digestOf({
      input: { fixture: computedDigest, baseline: pinOf('baseline').digest, published: pinOf('published').digest, standards: fixture.standards },
      solve: comparison.solve.map(verdict => [verdict.taskId, verdict.gain, verdict.met]),
      holdout: comparison.holdout.map(verdict => [verdict.taskId, verdict.gain, verdict.met]),
    })
    check('the conclusion\'s identity is the digest of the frozen input and every verdict it states',
      handBuiltConclusion === conclusion)

    // The replay: the same cutoff, folded again from the same entries, aggregated again by the same
    // probe. What is replayed is the reading, and the reading must not depend on when it was taken.
    const cutoff = store.load().entries().length
    const replayed = taskIds.map(taskId => ({
      taskId,
      baseline: projectEvaluation(foldSubjects(registry, store.load().entries(), MEASURE_PROTOCOL, MEASURE_VERSION).get(`${taskId}-baseline`)),
      published: projectEvaluation(foldSubjects(registry, store.load().entries(), MEASURE_PROTOCOL, MEASURE_VERSION).get(`${taskId}-published`)),
    }))
    check('re-folding the frozen entries reproduces both sides\' aggregates, digit for digit',
      replayed.every(entry =>
        close(entry.baseline.quality, views[`${entry.taskId}-baseline`].quality) &&
        close(entry.published.quality, views[`${entry.taskId}-published`].quality) &&
        entry.baseline.observed === views[`${entry.taskId}-baseline`].observed &&
        entry.published.missing.length === views[`${entry.taskId}-published`].missing.length))
    // Re-aggregate from the log at the cutoff and re-derive the conclusion from those verdicts: same
    // inputs, same reading, same digest. The comparison below changes one verdict's answer without
    // touching its numbers, so a conclusion digest that does not cover the answer is a digest that
    // would call two different conclusions one.
    const reread = taskIds.map(taskId => verdictOf('replay', 'published', taskId, standards))
    const rereadDigest = digestOfConclusion({ solve: reread.filter(verdict => verdict.set === 'solve'), holdout: reread.filter(verdict => verdict.set === 'holdout') })
    const flipped = verdict => ({ ...verdict, met: !verdict.met })
    const driftDigest = digestOfConclusion({ solve: reread.filter(verdict => verdict.set === 'solve').map(flipped), holdout: reread.filter(verdict => verdict.set === 'holdout').map(flipped) })
    check('replaying the same cutoff reproduces the same conclusion, from the same frozen identities',
      rereadDigest === conclusion && cutoff === store.load().entries().length,
      `${rereadDigest} vs ${conclusion}`)
    check('and the conclusion\'s identity covers the answer, not only the numbers',
      driftDigest !== conclusion)
    check('and there are facts above the cutoff for the replay to be a claim about the cutoff',
      store.load().entries().length === cutoff)

    // --------------------------------------------------------------------------- 6. replay from disk
    console.log('\n== replay: the same log reopened from its own bytes')
    const facts = store.load().entries().length
    await store.close()
    store = await ControlSessionStore.open({ persistence: live.persistence, controlId: CONTROL, registry, subjects, cwd: workspace })
    const reopened = store.load()
    check('the reopened store holds every committed fact', reopened.entries().length === facts, String(reopened.entries().length))
    const reopenedCalibers = taskIds.map(taskId => caliberDigestOf(reopened.stateOf(MEASURE_PROTOCOL, MEASURE_VERSION, `${taskId}-baseline`)))
    check('the reopened log still freezes the fixture\'s caliber on both sides',
      taskIds.every(taskId =>
        caliberDigestOf(reopened.stateOf(MEASURE_PROTOCOL, MEASURE_VERSION, `${taskId}-baseline`)) === caliberByName[`${taskId}-baseline`] &&
        caliberDigestOf(reopened.stateOf(MEASURE_PROTOCOL, MEASURE_VERSION, `${taskId}-published`)) === caliberByName[`${taskId}-baseline`]),
      `${reopenedCalibers.length} reopened calibers`)
    const reopenedViews = taskIds.map(taskId => [taskId, projectEvaluation(reopened.stateOf(MEASURE_PROTOCOL, MEASURE_VERSION, `${taskId}-published`))])
    check('and the reopened numbers are the numbers the runs produced',
      reopenedViews.every(([taskId, view]) => close(view.quality, views[`${taskId}-published`].quality)))

    // ------------------------------------------------------------------------- the readout
    console.log('')
    console.log(`  fixture ${computedDigest}`)
    console.log(`  tasks ${taskIds.length} (solve ${solveSet.length}, holdout ${holdoutSet.length}); trials per side ${fixture.frozen.trials}`)
    console.log(`  caliber ${caliberByName[`${taskIds[0]}-baseline`]} (one per task: a task's own inputs are part of the question)`)
    console.log(`  solve   baseline ${solveAggregate.baseline.toFixed(4)} -> published ${solveAggregate.quality.toFixed(4)}, gain ${solveAggregate.gain.toFixed(4)} (floor ${solveAggregate.worstCaseGain.toFixed(4)}) → met ${solveAggregate.met}`)
    console.log(`  holdout baseline ${holdoutAggregate.baseline.toFixed(4)} -> published ${holdoutAggregate.quality.toFixed(4)}, gain ${holdoutAggregate.gain.toFixed(4)}, complete ${holdoutAggregate.complete} → met ${holdoutAggregate.met}`)
    console.log(`  below bar: ${belowBarVerdict.taskId} ${belowBarVerdict.baseline.toFixed(4)} -> ${belowBarVerdict.candidate.toFixed(4)}, gain ${belowBarVerdict.gain.toFixed(4)} → met ${belowBarVerdict.met} (standard minQualityGain ${standards.minQualityGain})`)
    console.log(`  facts ${facts}; checks ${checks}`)
    console.log('  unobserved: the numbers were produced by probe-authored method files, not by a real model — the declared')
    console.log('              model is a fixture name and no model call happened; the real-model route is scripts/model-smoke.mjs,')
    console.log('              deliberately not a gate because it needs network and credentials.')
    console.log('  unobserved: the behaviour regression half of F\'s exit condition is the four probes that already exist')
    console.log('              (control-probe, recovery-probe, slice-b, cd-probe); F adds no regression mechanism of its own.')

    if (failures.length > 0) {
      console.error(`\ndomain-probe: ${failures.length} check(s) failed: ${failures.join(' | ')}`)
      process.exitCode = 1
    } else {
      console.log('\ndomain-probe: OK — the published method beats H0 on the frozen solve set under one caliber, and the frozen standards say so')
    }
  } finally {
    try {
      await store.close()
    } catch {
      // The refusal is the outcome; a teardown failure must not replace it.
    }
    await rm(root, { recursive: true, force: true })
  }
}

await main()

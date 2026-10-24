#!/usr/bin/env node
/**
 * C — one real measurement, end to end, observed rather than asserted about a stub.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openPersistence } from './dsh-control-runtime.mjs'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import { ProtocolRefusal } from '../src/protocol/refusal.ts'
import { declareTaskProtocol, TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, verifierRoleOf } from '../src/task/protocol.ts'
import { declareMeasureProtocol, MEASURE_PROTOCOL, MEASURE_VERSION } from '../src/measure/protocol.ts'
import { createMeasureCommands } from '../src/measure/commands.ts'
import { runMeasurement } from '../src/measure/execution.ts'
import { projectEvaluation } from '../src/measure/view.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ADAPTER = join(HERE, 'measure-runner.mjs')

const TASK = 'probe-task'
const RUN = 'probe-run'
const EVALUATION = 'probe-eval'
const AGENT = 'probe-agent'
const SCHEDULER = 'scheduler-1'
const METER = 'meter'
const BOUNDS = 'bounds'
const METER_ACTOR = 'meter-service'
const BOUNDS_ACTOR = 'bounds-service'
const INPUT_NAME = 'in/words.txt'
const ARTIFACT_NAME = 'out/artifact.txt'
const INPUT_BYTES = 'GOOD probe words'
const BASELINE = { environmentId: 'probe-library', revisionId: 'r0000', digest: 'a'.repeat(64) }
const CANDIDATE = { environmentId: 'probe-library', revisionId: 'r0001', digest: 'b'.repeat(64) }

/**
 * The measurement program, as real bytes on disk. `mode = fail` is a run that produced no number;
 */
const METER_SOURCE = [
  "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'",
  'const [inputPath, artifactPath, markerPath, label, quality, cost, mode] = process.argv.slice(2)',
  'appendFileSync(markerPath, `${label}\\n`)',
  "if (mode === 'fail') process.exit(3)",
  "const text = readFileSync(inputPath, 'utf8')",
  'writeFileSync(artifactPath, text.trim().toUpperCase())',
  "console.log(cost === '-' ? JSON.stringify({ quality: Number(quality) }) : JSON.stringify({ quality: Number(quality), cost: Number(cost) }))",
].join('\n')

/** The constraint program: it exits 0 or 1, and its exit code is the check. */
const BOUNDS_SOURCE = [
  "import { appendFileSync } from 'node:fs'",
  'const [markerPath, label, mode] = process.argv.slice(2)',
  'appendFileSync(markerPath, `${label}\\n`)',
  "process.exit(mode === 'fail' ? 1 : 0)",
].join('\n')

const failures = []
const line = value => console.log(`  ${value}`)
function check(label, condition, detail) {
  if (condition) console.log(`  ok    ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const TEMPLATE = { id: 'measure-probe', digest: sha256(await readFile(new URL(import.meta.url))) }

/** One process for real, without letting a non-zero exit throw. */
function runProcess(file, args) {
  return new Promise(resolve => {
    execFile(file, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr })
    })
  })
}

async function refusalOf(run) {
  try {
    await run()
  } catch (error) {
    if (error instanceof ProtocolRefusal) return error.refusal
    throw error
  }
  throw new Error('expected a refusal')
}

async function markerText(marker) {
  try {
    return await readFile(marker, 'utf8')
  } catch {
    return ''
  }
}

/** The real measurement port: spawn the adapter, then report the digest of what actually ran. */
function realMeasurement(programDigest) {
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
      implementationDigest: programDigest,
      detail: reported.detail,
    }
  }
}

/** A meter invocation: a label for the marker, a quality, a cost (`-` = none), and a mode. */
const meterCommand = (program, input, artifact, marker, label, quality, cost, mode) =>
  [process.execPath, program, input, artifact, marker, label, quality, cost, mode].map(entry => `"${entry}"`).join(' ')

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'measure-probe-'))
  const workspace = join(root, 'workspace')
  await mkdir(join(workspace, 'in'), { recursive: true })
  await mkdir(join(workspace, 'out'), { recursive: true })
  const input = join(workspace, INPUT_NAME)
  const artifact = join(workspace, ARTIFACT_NAME)
  const marker = join(root, 'ran.log')
  const meterProgram = join(root, 'meter.mjs')
  const boundsProgram = join(root, 'bounds.mjs')
  const goodSample = join(root, 'good.txt')
  const brokenSample = join(root, 'broken.txt')
  await writeFile(input, INPUT_BYTES, 'utf8')
  await writeFile(artifact, 'stale bytes from before the measurement', 'utf8')
  await writeFile(meterProgram, METER_SOURCE, 'utf8')
  await writeFile(boundsProgram, BOUNDS_SOURCE, 'utf8')
  await writeFile(goodSample, 'GOOD sample', 'utf8')
  await writeFile(brokenSample, 'BROKEN sample', 'utf8')
  const meterDigest = sha256(await readFile(meterProgram))
  const boundsDigest = sha256(await readFile(boundsProgram))

  const { ControlSessionStore } = await import('../src/control/session-store.ts')
  const live = await openPersistence(root)
  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry)
  declareMeasureProtocol(registry)
  const subjects = {
    scheduler: SCHEDULER,
    [verifierRoleOf({ verifierRef: METER, verifierVersion: '1' })]: METER_ACTOR,
    [verifierRoleOf({ verifierRef: BOUNDS, verifierVersion: '1' })]: BOUNDS_ACTOR,
  }
  const store = await ControlSessionStore.open({
    persistence: live.persistence,
    controlId: 'measure-probe',
    registry,
    subjects,
  })

  try {
    // The execution context the measurement happens in. These are the task protocol's facts, emitted
    // straight into the log: what this probe is about is the measurement, not task admission.
    const facts = [
      {
        kind: TASK_KINDS.admitted,
        payload: {
          contract: {
            artifact: ARTIFACT_NAME,
            goal: 'probe the measurement path',
            template: TEMPLATE,
            inputs: [{ name: INPUT_NAME, source: { kind: 'protected', ref: INPUT_NAME, digest: sha256(INPUT_BYTES) } }],
            criteria: [{ criterionId: 'counted', statement: 'the count is right' }],
          },
        },
      },
      { kind: TASK_KINDS.assigned, payload: { agentId: AGENT, agentIdentity: SCHEDULER } },
      { kind: TASK_KINDS.runStarted, payload: { runId: RUN, revision: BASELINE, purpose: 'evaluation' } },
      {
        kind: TASK_KINDS.bubbleOpened,
        payload: {
          runId: RUN,
          inputs: [{ name: INPUT_NAME, digest: sha256(INPUT_BYTES) }],
          workspace: { kind: 'dir', ref: workspace },
          model: { provider: 'probe', model: 'probe-model-1' },
          tools: [{ name: 'count', implementationDigest: meterDigest, version: '1' }],
          conditions: ['no-network'],
        },
      },
    ]
    for (const [index, fact] of facts.entries())
      await store.emit({
        commandId: `probe-fixture-${index}`,
        protocol: TASK_PROTOCOL,
        version: TASK_VERSION,
        subject: TASK,
        ...fact,
      })

    const measure = createMeasureCommands({
      store,
      registry,
      implementations: [
        { ref: METER, version: '1', implementationDigest: meterDigest },
        { ref: BOUNDS, version: '1', implementationDigest: boundsDigest },
      ],
      subjects,
    })
    const metric = {
      measured: {
        criterionId: 'quality',
        statement: 'the artifact holds the upper-cased input',
        verifierRef: METER,
        verifierVersion: '1',
        implementationDigest: meterDigest,
      },
      unit: 'points',
      direction: 'higher',
    }
    const judgement = [
      {
        criterionId: 'limits',
        statement: 'the artifact stays under 1 MiB',
        verifierRef: BOUNDS,
        verifierVersion: '1',
        implementationDigest: boundsDigest,
      },
    ]
    const meterImplementation = {
      ref: METER,
      version: '1',
      implementationDigest: meterDigest,
      selftest: {
        samples: [
          {
            name: 'measures a good input',
            expected: 'pass',
            input: { subject: goodSample, artifactDigest: sha256('good'), inputs: [] },
          },
          {
            name: 'produces no number for a broken run',
            expected: 'fail',
            input: { subject: brokenSample, artifactDigest: sha256('broken'), inputs: [] },
          },
        ],
      },
      judge: async sample => {
        const mode = sample.subject === brokenSample ? 'fail' : 'measure'
        const ran = await runProcess(process.execPath, [
          meterProgram,
          sample.subject,
          join(root, 'sample-artifact.txt'),
          marker,
          'sample',
          '0.5',
          '-',
          mode,
        ])
        return { verdict: ran.code === 0 ? 'pass' : 'fail' }
      },
    }
    const measureOne = async (label, quality, cost, mode) => {
      const outcome = await runMeasurement({
        metric: metric.measured,
        implementations: [meterImplementation],
        inputs: [{ name: INPUT_NAME, digest: sha256(INPUT_BYTES) }],
        workspace,
        artifactPath: ARTIFACT_NAME,
        command: meterCommand(meterProgram, input, artifact, marker, label, quality, cost, mode),
        measure: realMeasurement(meterDigest),
      })
      return outcome
    }

    console.log('\n== 1. the plan, and a real measured slot')
    await measure.openEvaluation({
      commandId: 'probe-open',
      evaluationId: EVALUATION,
      baseline: BASELINE,
      candidate: CANDIDATE,
      run: { taskId: TASK, runId: RUN },
      metric,
      weights: { quality: 1, cost: 0.5 },
      trials: 2,
      judgement,
    })
    const first = await measureOne('slot-0', '1', '-', 'measure')
    check('the measurement program ran in a real process', (await markerText(marker)).includes('slot-0'))
    check(
      'the adapter returned a trial rather than a miss',
      first.kind === 'trial',
      first.kind === 'missed' ? first.reason : undefined,
    )
    check(
      'the artifact digest is the digest of the bytes the program left behind',
      first.trial?.artifactDigest === sha256(INPUT_BYTES.toUpperCase()),
    )
    check('the program reported no cost', first.trial?.cost === undefined)
    await measure.recordTrial({
      commandId: 'probe-trial-0',
      evaluationId: EVALUATION,
      trial: { slot: 0, ...first.trial },
    })
    const committed = store.load().stateOf(MEASURE_PROTOCOL, MEASURE_VERSION, EVALUATION)
    check(
      'the folded trial names the implementation that produced it, by content digest',
      committed?.observed[0]?.implementationDigest === meterDigest,
    )
    check(
      'the folded trial is bound to the run declaration',
      JSON.stringify(committed?.observed[0]?.inputDigests) ===
        JSON.stringify([{ name: INPUT_NAME, digest: sha256(INPUT_BYTES) }]),
    )

    console.log('\n== 2. a slot the plan asked for and the run did not produce')
    const second = await measureOne('slot-1', '0', '-', 'fail')
    check(
      'a program that produced no number is reported as a miss',
      second.kind === 'missed',
      second.kind === 'trial' ? 'it reported a trial' : undefined,
    )
    await measure.missTrial({ commandId: 'probe-miss-1', evaluationId: EVALUATION, slot: 1, reason: second.reason })

    console.log('\n== 3. the projection: the denominator is the plan, not the observations')
    // The constraint's own program runs for real, and its exit code is the check.
    const boundsRun = await runProcess(process.execPath, [boundsProgram, marker, 'bounds', 'fail'])
    await measure.checkConstraint({
      commandId: 'probe-check',
      evaluationId: EVALUATION,
      criterionId: 'limits',
      met: boundsRun.code === 0,
      artifactDigest: first.trial.artifactDigest,
      implementationDigest: boundsDigest,
    })
    const view = projectEvaluation(store.load().stateOf(MEASURE_PROTOCOL, MEASURE_VERSION, EVALUATION))
    check("the denominator is the plan's two slots", view.denominator === 2, String(view.denominator))
    check('one observation is counted', view.observed === 1, String(view.observed))
    check('incomplete measurement has no quality aggregate', view.quality === null, String(view.quality))
    check(
      'the empty slot is named',
      view.missing.length === 1 && view.missing[0].slot === 1,
      JSON.stringify(view.missing),
    )
    check('the declared miss keeps its own reason', view.missing[0]?.reason === second.reason, view.missing[0]?.reason)
    check('an unobserved cost stays unknown rather than becoming zero', view.cost === null, String(view.cost))
    check('a perfect observed score with an unmet constraint is still inadmissible', view.admissible === false)
    check(
      'the reason names the constraint that failed',
      (view.why ?? '').includes('hard constraint "limits"') && (view.why ?? '').includes('not met'),
      view.why,
    )

    console.log('\n== 4. a rebuilt implementation is not found by its name')
    const rebuilt = { ref: METER, version: '1', implementationDigest: sha256('rebuilt meter bytes') }
    const before = await markerText(marker)
    const refusal = await refusalOf(() =>
      runMeasurement({
        metric: { ...metric.measured, implementationDigest: rebuilt.implementationDigest },
        // The deployment holds the implementation it built, under that build's digest — not the
        // digest this metric names.
        implementations: [meterImplementation],
        inputs: [{ name: INPUT_NAME, digest: sha256(INPUT_BYTES) }],
        workspace,
        artifactPath: ARTIFACT_NAME,
        command: meterCommand(meterProgram, input, artifact, marker, 'rebuilt', '1', '-', 'measure'),
        measure: realMeasurement(rebuilt.implementationDigest),
      }),
    )
    check('the refusal is unregistered-verifier', refusal.code === 'unregistered-verifier', refusal.code)
    check('the rebuilt implementation never ran', (await markerText(marker)) === before)

    const committedFacts = store.load().entries().length
    console.log('')
    line(
      `facts ${committedFacts}; denominator ${view.denominator}; observed ${view.observed}; quality ${view.quality}; cost ${view.cost}`,
    )
    line(
      `meter ${meterDigest.slice(0, 16)}…; artifact ${(first.trial?.artifactDigest ?? '').slice(0, 16)}…; marker ${JSON.stringify((await markerText(marker)).trim().split('\n'))}`,
    )
    line(`admissible ${view.admissible}; why ${view.why}`)
  } finally {
    await store.close()
    await live.context.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

await main()

if (failures.length > 0) {
  console.error(`\nmeasure-probe: ${failures.length} check(s) failed: ${failures.join(' | ')}`)
  process.exitCode = 1
} else {
  console.log('\nmeasure-probe: OK — a real measurement, a correct denominator, and a constraint no score buys')
}

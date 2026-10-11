#!/usr/bin/env node
/**
 * The RSI loop, live, on one pipeline: a real model writes the artifact inside a decomposed sub-task,
 * a real verifier judges it, the verdict is recorded once, the subtree's receipt and the measurement
 * both cite that one fact, and the pointer moves because the reading moved.
 *
 * Every other probe stops one step short of this. `cd-probe.mjs` runs the whole C+D seam but its
 * method files are written by the probe, so what it measures is a program the probe wrote.
 * `model-smoke.mjs` observes a real model with no pipeline attached. `slice-b.mjs` runs the real
 * Task/Run/verdict/receipt path with a counting script as the worker — the apparatus is real and the
 * worker is not. Here the worker is the model, its runs start through the agent's own command surface
 * inside a plan the campaign declared, and the receipt is derived on the model's own run.
 *
 * The shape of one round:
 *
 *   0. the campaign declares its work structure once: the root holds the contract and runs the
 *      library's own programs (the baselines), two delegated attempts support its criterion, and the
 *      second depends on the first — round two's prompt carries round one's verdict and numbers, so
 *      the plan states the order the work actually happens in;
 *   1. the model reads the task statement and answers with **the artifact itself** — a program, not a
 *      description of one — and this file writes what it answered to disk;
 *   2. that program runs on the real input and writes an output, which is the artifact everything is
 *      about;
 *   3. the criterion's verifier — a real program the criterion pins by content digest — is **spawned**
 *      through the production verdict path to judge that artifact, reads the bytes on disk, and exits
 *      with its verdict;
 *   4. the verdict is recorded **once**, as a Task evidence fact;
 *   5. the measurement records the numbers through its own command boundary and checks the hard
 *      constraint, **citing that verdict's digest** rather than recording a second judgment;
 *   6. the round pools the candidate against one incumbent, elects it, the release path drafts it, the
 *      native `ctx.approval` seam approves the digest on the table, and `environment@2`'s
 *      compare-and-swap moves the head;
 *   7. the run settles as its verdict says, and the subtree's receipt — derived from the committed
 *      prefix, which is the only source it has — reads the same verdict fact the constraint cited:
 *      one judgment, one fact, two readers that cannot disagree.
 *
 * **Why the pipelines meet at evidence rather than at code.** The verdict belongs to the task
 * protocol, which is the only thing that knows what a criterion is; the number belongs to the measure
 * protocol, which is the only thing that knows what is being compared. Neither imports the other's
 * judgment: the measurement cites `evidenceDigest`, and the citation is **checked** — the constraint
 * refuses a verdict about bytes this evaluation did not measure, and refuses a verdict of a criterion
 * other than the one it is checking. So "the round elected a revision the verifier passed" is a chain
 * of facts in one log rather than a claim a script makes.
 *
 * **The model sees the task, not the apparatus.** The prompt carries `DOMAIN.md` and the input; it
 * never sees the verifier, the meter, the reference, this file, or the round. Round two adds what round
 * one *measured*: the verdict the verifier recorded, its own words about why, and the numbers.
 *
 * **One direction.** This file imports the pipeline and the route; neither imports this file, and
 * nothing in `src/` can reach a model.
 *
 * **Not observed.** That the model answers the same way twice, or that it improves in general: one
 * sample per round was measured. No check depends on what the model wrote — the verdict is the
 * verifier's, and the round reads it.
 *
 * Run: node scripts/rsi-live.mjs                            (keep the workspace: RSI_LIVE_KEEP=1)
 *      node scripts/rsi-live.mjs --round1 <a.mjs> <b.mjs>   replay recorded programs, no network
 *
 * @module singularity-core/scripts/rsi-live
 */

import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dshModule, openPersistence } from './dsh-control-runtime.mjs'
import { realModel, ROUTE } from './llm-route.mjs'

const CONTROL = 'rsi-live'
const ENVIRONMENT = 'library-live'
const TASK = 'live-task'
const ATTEMPT1 = 'attempt-1'
const ATTEMPT2 = 'attempt-2'
const AGENT = 'live-agent'
const METER = 'meter'
const BOUNDS = 'bounds'
const PRODUCER = 'producer'
const WEIGHTS = { quality: 100, cost: 15 }
const FLOOR = { floor: 0.1, source: 'measured' }
const CONDITIONS = 'deterministic'
const INPUT_NAME = 'in/input.txt'
const ADAPTER = join(new URL('.', import.meta.url).pathname, 'verifier-command.mjs')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const TEMPLATE = { id: 'rsi-live-probe', digest: sha256(await readFile(new URL(import.meta.url))) }
const shellLine = argv => argv.map(entry => JSON.stringify(String(entry))).join(' ')

/** The input the whole campaign is about: letters, digits, spaces, punctuation and newlines. */
const INPUT = `A tally of the words a consumer actually wants: 42 tokens, 7 of them rare!
Mixed CASE matters, and so does punctuation -- hyphens count too, as do digits
like 2026. What must the report count: words, letters, or bytes? The task says.
`

/**
 * The one criterion's verifier: a real program that reads the artifact and the input and exits 0 when
 * the artifact is the letter count. It is the criterion's implementation, pinned by content digest,
 * and it decides in both directions — a wrong number is a `fail`, not a missing answer.
 */
const VERIFIER_SOURCE = [
  "import { readFileSync } from 'node:fs'",
  'const [artifactPath, inputPath] = process.argv.slice(2)',
  "const artifact = readFileSync(artifactPath, 'utf8').trim()",
  "const input = readFileSync(inputPath, 'utf8')",
  'const letters = (input.match(/[A-Za-z]/g) ?? []).length',
  'const claimed = Number(artifact)',
  'if (!Number.isInteger(claimed)) { console.error(`the artifact is not an integer count: ${JSON.stringify(artifact.slice(0, 40))}`); process.exit(1) }',
  'if (claimed !== letters) { console.error(`the artifact claims ${claimed} letters; the input holds ${letters}`); process.exit(1) }',
  'console.log(`letters ${letters}`)',
].join('\n')

/** The metric's implementation: 1 when the recorded verdict passed, 0 when it failed. */
const METER_SOURCE = [
  "import { readFileSync } from 'node:fs'",
  'const [verdictPath] = process.argv.slice(2)',
  "const passed = readFileSync(verdictPath, 'utf8').trim() === 'pass'",
  // It scores what the producer wrote and writes nothing itself: the artifact a measurement is bound to
  // is the producer's bytes, which are also the bytes the verdict judged.
  'console.log(JSON.stringify({ quality: passed ? 1 : 0, cost: 0 }))',
].join('\n')

/**
 * The hard constraint, as a program that can fail and can pass: it exits 0 when the recorded verdict
 * passed. It is deliberately a *different* implementation from the metric, because the metric says how
 * well a candidate did and the constraint says whether it may enter the comparison at all.
 */
const BOUNDS_SOURCE = [
  "import { readFileSync } from 'node:fs'",
  'const [artifactPath, verdictPath] = process.argv.slice(2)',
  "process.exit(readFileSync(verdictPath, 'utf8').trim() === 'pass' ? 0 : 1)",
].join('\n')

/** The task as the model receives it. This text is the frozen standard the campaign is judged under. */
const DOMAIN = `# Task: write the count report

The consumer wants one number from \`${INPUT_NAME}\`: **how many letters the input holds**, where a
letter is one of \`A\`–\`Z\` or \`a\`–\`z\` and nothing else is one — digits, spaces, punctuation and
newlines are not letters, and case does not matter.

## What you write

One file, in JavaScript, run as:

    node <your file> <input path>

It must print the number to standard output and nothing else, and it must exit 0. It may not read any
file other than the one it is given on the command line. Node runs the file as an **ES module**: a bare
\`require(...)\` is not defined, so import what you need (\`import { readFileSync } from 'node:fs'\`).

## How it is judged

A verifier the pipeline holds reads your output, reads the input, computes the number itself, and
records **pass** or **fail**. Your file is not trusted and is not read by the verifier: only the number
you printed is judged, against the input's bytes. A wrong number, a non-integer, or anything other than
the number is a fail.

## The hard constraint

A candidate may only enter the comparison if the verifier **passed** it. A number that looks good but
did not pass is refused however well it scores, so getting the rule right matters more than getting a
plausible number.

## Your answer

One fenced JavaScript block and nothing else — no prose, no explanation.
`

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

function runProcess(file, args) {
  return new Promise(resolve => {
    execFile(file, [...args], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr })
    })
  })
}

async function refusalOf(step) {
  const { ProtocolRefusal } = await import('../src/protocol/refusal.ts')
  try {
    await step()
  } catch (error) {
    if (error instanceof ProtocolRefusal) {
      refusals += 1
      return error.refusal
    }
    throw error
  }
  return { code: 'no-refusal', detail: 'accepted where this probe expected a refusal' }
}

/** The program in the model's answer: one fenced block, or the whole reply when it is bare code. */
function programOf(reply) {
  const fenced = /```(?:js|javascript)?\s*([\s\S]*?)```/.exec(reply)
  const body = (fenced === null ? reply : fenced[1]).trim()
  if (body === '') throw new Error(`the answer holds no program: ${JSON.stringify(reply.slice(0, 120))}`)
  if (!/console\.log|process\.stdout/.test(body)) throw new Error(`the answer prints nothing: ${JSON.stringify(body.slice(0, 120))}`)
  return `${body}\n`
}

async function main() {
  const { ControlSessionStore } = await import('../src/control/session-store.ts')
  const { ProtocolRegistry } = await import('../src/protocol/registry.ts')
  const { foldSubjects } = await import('../src/protocol/fold.ts')
  const { declareTaskProtocol, TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, recordedVerdictDigest, verifierRoleOf } = await import('../src/task/protocol.ts')
  const { declareAgentProtocol, AGENT_KINDS, AGENT_PROTOCOL, AGENT_VERSION, AGENT_ROLE } = await import('../src/agent/protocol.ts')
  const { projectReceipt, receiptDigest } = await import('../src/task/view.ts')
  const { projectTree } = await import('../src/task/tree.ts')
  const { createTaskCommands } = await import('../src/task/commands.ts')
  const { runProductionVerdict } = await import('../src/verifier/production.ts')
  const env = await import('../src/environment/protocol.ts')
  const { declareMeasureProtocol, MEASURE_PROTOCOL, MEASURE_VERSION } = await import('../src/measure/protocol.ts')
  const { declareStrategyProtocol, STRATEGY_PROTOCOL, STRATEGY_VERSION, STRATEGY_ROLE } = await import('../src/strategy/protocol.ts')
  const { declareReleaseProtocol, APPROVER_ROLE } = await import('../src/release/protocol.ts')
  const { createMeasureCommands } = await import('../src/measure/commands.ts')
  const { createStrategyCommands } = await import('../src/strategy/commands.ts')
  const { createReleaseCommands } = await import('../src/release/commands.ts')
  const { caliberDigestOf, projectEvaluation } = await import('../src/measure/view.ts')
  const { contextDigestOf } = await import('../src/measure/protocol.ts')
  const { projectRound } = await import('../src/strategy/view.ts')
  const { runMeasurement } = await import('../src/measure/execution.ts')

  const root = await mkdtemp(join(tmpdir(), 'singularity-rsi-live-'))
  const workspace = join(root, 'workspace')
  const sessions = join(root, 'sessions')
  await mkdir(join(workspace, 'in'), { recursive: true })
  await mkdir(join(workspace, 'out'), { recursive: true })
  await mkdir(join(workspace, 'artifacts'), { recursive: true })
  await mkdir(sessions, { recursive: true })

  const inputPath = join(workspace, INPUT_NAME)
  const domainPath = join(workspace, 'DOMAIN.md')
  const verifierProgram = join(root, 'verifier.mjs')
  const meterProgram = join(root, 'meter.mjs')
  const boundsProgram = join(root, 'bounds.mjs')
  const programPathOf = revisionId => join(workspace, 'artifacts', `${revisionId}.mjs`)
  // Declared as names inside the workspace, which is what the production verdict path resolves and
  // contains; the absolute paths below are only how this file reaches the same bytes.
  const artifactNameOf = revisionId => `artifacts/${revisionId}.out`
  const verdictNameOf = revisionId => `artifacts/${revisionId}.verdict`
  const artifactPathOf = revisionId => join(workspace, artifactNameOf(revisionId))
  const verdictPathOf = revisionId => join(workspace, verdictNameOf(revisionId))
  await writeFile(inputPath, INPUT, 'utf8')
  await writeFile(domainPath, DOMAIN, 'utf8')
  await writeFile(verifierProgram, VERIFIER_SOURCE, 'utf8')
  await writeFile(meterProgram, METER_SOURCE, 'utf8')
  await writeFile(boundsProgram, BOUNDS_SOURCE, 'utf8')

  // The incumbent: the naive program, which counts bytes. Wrong for a task about letters, which is the
  // point — a round is only interesting if the incumbent can be beaten.
  await writeFile(programPathOf('r0000'), "import { readFileSync } from 'node:fs'\nconsole.log(readFileSync(process.argv[2], 'utf8').length)\n", 'utf8')

  const verifierDigest = sha256(await readFile(verifierProgram))
  const meterDigest = sha256(await readFile(meterProgram))
  const boundsDigest = sha256(await readFile(boundsProgram))
  const INPUTS = [{ name: INPUT_NAME, digest: sha256(await readFile(inputPath)) }]
  const CONTEXT = {
    model: ROUTE,
    tools: [{ name: PRODUCER, implementationDigest: verifierDigest, version: '1' }, { name: METER, implementationDigest: meterDigest, version: '1' }],
    conditions: [CONDITIONS],
  }

  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry)
  declareAgentProtocol(registry)
  declareMeasureProtocol(registry)
  declareStrategyProtocol(registry)
  declareReleaseProtocol(registry)
  env.declareEnvironmentProtocol(registry)
  const subjects = {
    scheduler: 'scheduler-service',
    [AGENT_ROLE]: 'agent-runtime-service',
    [verifierRoleOf({ verifierRef: PRODUCER, verifierVersion: '1' })]: 'producer-verifier-service',
    [verifierRoleOf({ verifierRef: METER, verifierVersion: '1' })]: 'meter-service',
    [verifierRoleOf({ verifierRef: BOUNDS, verifierVersion: '1' })]: 'bounds-service',
    [STRATEGY_ROLE]: 'strategy-service',
    [APPROVER_ROLE]: 'approval-seam',
    [env.ENVIRONMENT_ROLE]: 'environment-service',
    [env.PUBLISHER_ROLE]: 'publisher-service',
  }

  const live = await openPersistence(sessions)
  const store = await ControlSessionStore.open({ persistence: live.persistence, controlId: CONTROL, registry, subjects, cwd: workspace })
  let commandSeq = 0
  const nextId = prefix => `${prefix}-${(commandSeq += 1)}`
  const model = await realModel()
  const calls = []
  let approvalContext

  try {
    console.log(`session ${store.sessionId}; route ${model.route.provider}/${model.route.model}`)
    const askModel = async (label, prompt) => {
      const started = Date.now()
      const reply = await model.complete({ system: 'You answer with one fenced JavaScript program and nothing else.', prompt })
      calls.push({ label, elapsed: Date.now() - started, digest: sha256(reply), reply })
      console.log(`  ..    ${label}: asked ${prompt.length} byte(s), answered ${reply.length} byte(s) in ${calls.at(-1).elapsed}ms, sha256 ${calls.at(-1).digest.slice(0, 16)}…`)
      console.log(`  ..      answer: ${JSON.stringify(reply.slice(0, 200))}`)
      return reply
    }

    // ---------------------------------------------------------------- 1. the model writes the artifact
    console.log('\n== the model answers the task, seeing the statement and the input')
    const taskText = await readFile(domainPath, 'utf8')
    const inputText = await readFile(inputPath, 'utf8')
    const replayIndex = process.argv.indexOf('--round1')
    const replayed = replayIndex < 0 ? undefined : await readFile(process.argv[replayIndex + 1], 'utf8')
    const firstProgram = programOf(replayed ?? await askModel('round-1 answer', `${taskText}\n## The input, exactly as it is on disk\n\n\`\`\`\n${inputText}\`\`\`\n`))
    await writeFile(programPathOf('r0001'), firstProgram, 'utf8')
    check('the model answered with a program that prints something', /console\.log|process\.stdout/.test(firstProgram))
    check('this run is the model\'s own, not a replay of an earlier one', replayed === undefined && calls.length === 1, replayed === undefined ? `${calls.length} model call(s)` : '--round1 replayed a recorded program')

    // ---------------------------------------------------------------- 2. revisions, verdicts, numbers
    for (const revisionId of ['r0000', 'r0001'])
      await store.emit({
        commandId: nextId(`create-${revisionId}`),
        protocol: env.ENVIRONMENT_PROTOCOL,
        version: env.ENVIRONMENT_VERSION,
        kind: env.ENVIRONMENT_KINDS.revisionCreated,
        subject: ENVIRONMENT,
        payload: {
          revisionId,
          manifest: { skills: [], tools: [PRODUCER], taskTemplates: [TASK], artifact: { file: `artifacts/${revisionId}.mjs`, digest: sha256(await readFile(programPathOf(revisionId))) } },
        },
      })
    const environmentOf = () => store.load().stateOf(env.ENVIRONMENT_PROTOCOL, env.ENVIRONMENT_VERSION, ENVIRONMENT)
    const pinOf = revisionId => ({ environmentId: ENVIRONMENT, revisionId, digest: environmentOf().revisions[revisionId].contentDigest })
    const measureStateOf = evaluationId => store.load().stateOf(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)
    const roundStateOf = roundId => store.load().stateOf(STRATEGY_PROTOCOL, STRATEGY_VERSION, roundId)
    const stateOfTask = taskId => store.load().stateOf(TASK_PROTOCOL, TASK_VERSION, taskId)
    const bubbleIn = run => stateOfTask(run.taskId)?.runs[run.runId]?.bubble
    const lastSeq = () => store.load().entries().at(-1).seq
    await store.emit({
      commandId: nextId('point-at-r0000'), protocol: env.ENVIRONMENT_PROTOCOL, version: env.ENVIRONMENT_VERSION,
      kind: env.ENVIRONMENT_KINDS.pointerSwitched, subject: ENVIRONMENT, payload: { expected: '', to: 'r0000' },
    })
    check('every revision declares the digest of the program bytes on disk',
      (await Promise.all(['r0000', 'r0001'].map(async id => environmentOf().revisions[id].manifest.artifact.digest === sha256(await readFile(programPathOf(id)))))).every(Boolean) &&
      sha256(await readFile(programPathOf('r0000'))) !== sha256(await readFile(programPathOf('r0001'))))

    const commands = createTaskCommands({
      store,
      registry,
      subjects,
      agents: new Map([[AGENT, { as: 'scheduler' }]]),
      implementations: [{ ref: PRODUCER, version: '1', implementationDigest: verifierDigest }],
    })
    const asAgent = commands.forAgent(AGENT)
    const metric = { measured: { criterionId: 'counted', statement: 'the report is the letter count the verifier confirmed', verifierRef: METER, verifierVersion: '1', implementationDigest: meterDigest }, unit: 'confirmed', direction: 'higher' }
    // The hard constraint is its own criterion, because a plan may not judge the criterion it measures
    // and it may not judge a criterion that is not in the metric's own contract either. What ties it to
    // the verdict is the **citation**: the check names the task criterion the verdict came from, and
    // the bytes it names are the bytes the verdict judged.
    const judgement = [{ criterionId: 'bounded', statement: 'the verifier passed the report', verifierRef: BOUNDS, verifierVersion: '1', implementationDigest: boundsDigest }]
    // The campaign's work structure: the root holds the contract and runs the library's own programs
    // (the baselines), and each model answer is a delegated sub-task. The second attempt depends on
    // the first because round two's prompt carries round one's verdict and numbers — the plan states
    // the order the campaign actually works in.
    const contractOf = () => ({
      goal: 'report the number of letters in the input',
      template: TEMPLATE,
      inputs: [{ name: INPUT_NAME, source: { kind: 'protected', ref: INPUT_NAME, digest: INPUTS[0].digest } }],
      criteria: [{ criterionId: 'counted', statement: metric.measured.statement, verifierRef: PRODUCER, verifierVersion: '1', implementationDigest: verifierDigest }],
    })
    for (const [index, fact] of [
      { protocol: AGENT_PROTOCOL, version: AGENT_VERSION, kind: AGENT_KINDS.opened, subject: AGENT, payload: { agentId: AGENT, role: 'worker', sessionId: `singularity:agent:${AGENT}` } },
      { protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: TASK_KINDS.admitted, subject: TASK, payload: { contract: contractOf() } },
      { protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: TASK_KINDS.admitted, subject: ATTEMPT1, payload: { contract: contractOf() } },
      { protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: TASK_KINDS.admitted, subject: ATTEMPT2, payload: { contract: contractOf() } },
      { protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: TASK_KINDS.assigned, subject: TASK, payload: { agentId: AGENT, agentIdentity: subjects.scheduler } },
      { protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: TASK_KINDS.decomposed, subject: TASK, payload: { children: [
        { taskId: ATTEMPT1, dependsOn: [], supports: ['counted'], maxRuns: 1 },
        { taskId: ATTEMPT2, dependsOn: [ATTEMPT1], supports: ['counted'], maxRuns: 1 },
      ] } },
      { protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: TASK_KINDS.assigned, subject: ATTEMPT1, payload: { agentId: AGENT, agentIdentity: subjects.scheduler } },
      { protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: TASK_KINDS.assigned, subject: ATTEMPT2, payload: { agentId: AGENT, agentIdentity: subjects.scheduler } },
    ].entries())
      await store.emit({ commandId: nextId(`fixture-${index}`), ...fact })

    // The plan's own gate, live: the second attempt starts only after the first has verified, and the
    // refusal quotes the plan the same sentence a projection would.
    const tooEarly = await refusalOf(() => asAgent.startRun({ commandId: nextId('too-early'), taskId: ATTEMPT2, runId: 'run-early', revision: pinOf('r0000') }))
    check('a sub-task cannot start before the attempt it depends on has verified', tooEarly.code === 'illegal-transition' && tooEarly.detail.includes(ATTEMPT1), tooEarly.code)

    const runOf = evaluationId => `run-${evaluationId}`
    // Runs start through the agent's own command surface, so the plan's readiness and budget gates
    // and the responsibility check are the ones any agent's runs pass — not facts this file wrote.
    const beginRun = async (evaluationId, host) => {
      const runId = runOf(evaluationId)
      await asAgent.startRun({ commandId: nextId(`start-${runId}`), taskId: host, runId, revision: pinOf(environmentOf().pointer) })
      await asAgent.openBubble({
        commandId: nextId(`bubble-${runId}`), taskId: host, runId, inputs: INPUTS,
        workspace: { kind: 'dir', ref: workspace }, model: CONTEXT.model, tools: CONTEXT.tools, conditions: CONTEXT.conditions,
      })
      return { taskId: host, runId }
    }

    /**
     * The criterion's verifier, declared with a selftest that produces both verdicts: a gate that has
     * never failed is not known to work, and this one has to be able to say `fail` about real files.
     */
    const verifierImplementation = {
      ref: PRODUCER,
      version: '1',
      implementationDigest: verifierDigest,
      selftest: {
        samples: [
          { name: 'accepts the real count', expected: 'pass', input: { subject: inputPath, artifactDigest: sha256('letters'), inputs: [] } },
          { name: 'rejects a count that is not the input\'s', expected: 'fail', input: { subject: inputPath, artifactDigest: sha256('not-the-count'), inputs: [] } },
        ],
      },
      judge: async sample => {
        const scratch = join(workspace, 'out', `sample-${sha256(sample.subject + String(sample.artifactDigest)).slice(0, 8)}.txt`)
        // The number the criterion's own implementation would compute for this input, and a number it
        // would not: the selftest is the difference between them, on real bytes.
        const letters = ((await readFile(sample.subject, 'utf8')).match(/[A-Za-z]/g) ?? []).length
        await writeFile(scratch, sample.artifactDigest === sha256('letters') ? String(letters) : String(letters + 1), 'utf8')
        const adapter = await runProcess(process.execPath, [ADAPTER, JSON.stringify({
          command: shellLine([process.execPath, verifierProgram, scratch, sample.subject]),
          artifactPath: scratch,
          inputs: [],
        })])
        if (adapter.code !== 0) throw new Error(`the verifier adapter could not judge the sample: ${adapter.stderr}`)
        return { verdict: JSON.parse(adapter.stdout.trimEnd().split('\n')[0] ?? '{}').verdict }
      },
    }

    /**
     * The producer: run the revision's program on the real input, then have the criterion's verifier
     * judge what came out. Both are real processes, and the verdict is the verifier's exit code — never
     * anything this file decided. The judged artifact is the program's *output*, which is what the
     * verifier and the measurement both name.
     */
    const produce = async (where, revisionId) => {
      const { taskId: host, runId } = where
      const produced = await runProcess(process.execPath, [programPathOf(revisionId), inputPath])
      await writeFile(artifactPathOf(revisionId), produced.stdout, 'utf8')
      const judged = await runProductionVerdict({
        runId,
        criterion: { criterionId: 'counted', statement: metric.measured.statement, verifierRef: PRODUCER, verifierVersion: '1', implementationDigest: verifierDigest },
        implementations: [verifierImplementation],
        inputs: INPUTS,
        workspace,
        artifactPath: artifactNameOf(revisionId),
        command: [process.execPath, verifierProgram, artifactPathOf(revisionId), inputPath],
        runJudge: async execution => {
          const adapter = await runProcess(process.execPath, [ADAPTER, JSON.stringify({
            command: shellLine(execution.command),
            artifactPath: execution.artifactPath,
            inputs: execution.inputs.map(entry => ({ name: entry.name, digest: entry.digest, path: entry.path })),
          })])
          if (adapter.code !== 0) throw new Error(`the verifier adapter could not judge: ${adapter.stderr}`)
          const reported = JSON.parse(adapter.stdout.trimEnd().split('\n')[0] ?? '{}')
          return { verdict: reported.verdict, implementationDigest: sha256(await readFile(verifierProgram)), detail: reported.detail }
        },
      })
      await writeFile(verdictPathOf(revisionId), `${judged.verdict}\n`, 'utf8')
      console.log(`  ..    ${revisionId}: program exited ${produced.code}, printed ${JSON.stringify(produced.stdout.trim().slice(0, 40))}, verifier said ${judged.verdict}`)
      await commands.recordVerdict({
        commandId: nextId(`verdict-${revisionId}`),
        taskId: host,
        verdict: {
          runId,
          criterionId: 'counted',
          verdict: judged.verdict,
          implementationDigest: verifierDigest,
          artifactDigest: judged.artifactDigest,
          inputDigests: INPUTS,
          ...(judged.detail === undefined ? {} : { detail: judged.detail.slice(0, 200) }),
        },
      })
      // The citation is the protocol's own answer, not this file's arithmetic: ask the task state which
      // verdict it holds for these bytes, and cite the digest it reports.
      const evidenceDigest = recordedVerdictDigest(stateOfTask(host), `${revisionId}'s verdict`, {
        runId, criterionId: 'counted', artifactDigest: judged.artifactDigest,
      })
      await store.emit(judged.verdict === 'pass'
        ? { commandId: nextId(`settle-${runId}`), protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: TASK_KINDS.runVerified, subject: host, payload: { runId } }
        : { commandId: nextId(`settle-${runId}`), protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: TASK_KINDS.runFailed, subject: host, payload: { runId, cause: 'acceptance', reason: `the verifier recorded ${judged.verdict}` } })
      return { taskId: host, runId, verdict: judged.verdict, artifactDigest: judged.artifactDigest, evidenceDigest, detail: judged.detail }
    }

    const measure = createMeasureCommands({
      store,
      registry,
      implementations: [{ ref: METER, version: '1', implementationDigest: meterDigest }, { ref: BOUNDS, version: '1', implementationDigest: boundsDigest }],
      subjects,
    })
    /** One evaluation: its plan, two real trials of the recorded verdict, and the constraint checked. */
    const measurementOf = async (evaluationId, revisionId, baselineId, judged) => {
      await measure.openEvaluation({
        commandId: nextId(`open-${evaluationId}`), evaluationId, baseline: pinOf(baselineId), candidate: pinOf(revisionId),
        run: { taskId: judged.taskId, runId: judged.runId }, metric, weights: WEIGHTS, trials: 2, judgement,
      })
      for (const slot of [0, 1]) {
        const outcome = await runMeasurement({
          metric: metric.measured,
          implementations: [{
            ref: METER, version: '1', implementationDigest: meterDigest,
            selftest: { samples: [
              { name: 'a verdict that passed', expected: 'pass', input: { subject: 'pass', artifactDigest: sha256('pass'), inputs: [] } },
              { name: 'a verdict that failed', expected: 'fail', input: { subject: 'fail', artifactDigest: sha256('fail'), inputs: [] } },
            ] },
            // The selftest writes the verdict it is asked about and runs the meter on those bytes, so
            // both outcomes come from the program rather than from this file's opinion of it.
            judge: async sample => {
              const scratchVerdict = join(workspace, 'out', `sample-${sha256(String(sample.subject)).slice(0, 8)}.verdict`)
              const scratchReport = join(workspace, 'out', `sample-${sha256(String(sample.subject)).slice(0, 8)}.report`)
              await writeFile(scratchVerdict, `${sample.subject}\n`, 'utf8')
              const ran = await runProcess(process.execPath, [meterProgram, scratchVerdict, scratchReport])
              return { verdict: ran.code === 0 && ran.stdout.trim().startsWith('{"quality":1') ? 'pass' : 'fail' }
            },
          }],
          inputs: INPUTS,
          workspace,
          artifactPath: artifactNameOf(revisionId),
          command: shellLine([process.execPath, meterProgram, verdictPathOf(revisionId)]),
          measure: async execution => {
            const reported = await runProcess(process.execPath, [join('scripts', 'measure-runner.mjs'), JSON.stringify({
              command: execution.command, artifactPath: execution.artifactPath,
              inputs: execution.inputs.map(entry => ({ name: entry.name, digest: entry.digest, path: entry.path })),
            })])
            if (reported.code !== 0) throw new Error(`the measurement adapter could not measure: ${reported.stderr.trim() || reported.stdout.trim()}`)
            const line = reported.stdout.trimEnd().split('\n')[0] ?? ''
            if (line === '') throw new Error('the measurement adapter printed no report')
            const answer = JSON.parse(line)
            return { quality: answer.quality, cost: answer.cost ?? 0, implementationDigest: meterDigest, detail: `${judged.verdict}: ${judged.detail ?? ''}`.slice(0, 200) }
          },
        })
        if (outcome.kind === 'missed') await measure.missTrial({ commandId: nextId(`miss-${evaluationId}-${slot}`), evaluationId, slot, reason: outcome.reason })
        else await measure.recordTrial({ commandId: nextId(`trial-${evaluationId}-${slot}`), evaluationId, trial: { slot, ...outcome.trial } })
      }
      const boundsRan = await runProcess(process.execPath, [boundsProgram, artifactPathOf(revisionId), verdictPathOf(revisionId)])
      await measure.checkConstraint({
        commandId: nextId(`check-${evaluationId}`), evaluationId, criterionId: 'bounded',
        // The bytes this check is bound to are the ones the trials were formed on — the report the
        // meter wrote — and the citation names the verdict those bytes were judged against.
        met: boundsRan.code === 0, artifactDigest: judged.artifactDigest, implementationDigest: boundsDigest,
        verdict: { criterionId: 'counted', evidenceDigest: judged.evidenceDigest, artifactDigest: judged.artifactDigest },
        ...(judged.detail === undefined ? {} : { detail: judged.detail.slice(0, 200) }),
      })
      return projectEvaluation(measureStateOf(evaluationId))
    }

    /** The measure slice as one round reads it: the incumbent's aggregate below the round's own cutoff. */
    const sliceOf = cut => ({
      entries: cut.entries(),
      evaluationOf: evaluationId => {
        const state = cut.stateOf(MEASURE_PROTOCOL, MEASURE_VERSION, evaluationId)
        if (state?.trials === undefined || state.baseline === undefined || state.candidate === undefined) return undefined
        const caliberDigest = caliberDigestOf(state)
        return caliberDigest === undefined ? undefined : { evaluationId, caliberDigest, baseline: state.baseline, candidate: state.candidate, ...projectEvaluation(state) }
      },
      incumbentBelow: (revision, cutoff) => {
        const entries = cut.entriesOf(MEASURE_PROTOCOL, MEASURE_VERSION).filter(entry => entry.seq < cutoff)
        const opened = entries.filter(entry => entry.kind === 'evaluation/opened' && entry.payload.candidate?.revisionId === revision.revisionId).at(-1)
        if (opened === undefined) return null
        const view = projectEvaluation(foldSubjects(registry, entries, MEASURE_PROTOCOL, MEASURE_VERSION).get(opened.subject))
        return { quality: view.quality, cost: view.cost }
      },
    })
    const strategy = createStrategyCommands({ store, rounds: 4, firstBudget: 2, minimumBudget: 1, calibration: FLOOR, measuresAt: cut => sliceOf(cut) })

    // ---------------------------------------------------------------- 3. round one
    console.log('\n== round one: the incumbent against the model\'s program')
    const baselineVerdict = await produce(await beginRun('r1-baseline', TASK), 'r0000')
    const baseline = await measurementOf('r1-baseline', 'r0000', 'r0000', baselineVerdict)
    const baselineSeq = lastSeq()
    const candidateVerdict = await produce(await beginRun('r1-c0', ATTEMPT1), 'r0001')
    const candidate = await measurementOf('r1-c0', 'r0001', 'r0000', candidateVerdict)
    await strategy.openRound({
      commandId: nextId('open-round-1'), roundId: 'round-1', round: 1, incumbent: pinOf('r0000'), candidates: 1, explorationSlots: 0,
      historyCutoff: store.load().entries().length, caliber: caliberDigestOf(measureStateOf('r1-baseline')),
      metric: { direction: metric.direction }, weights: WEIGHTS,
    })
    await strategy.submitCandidate({ commandId: nextId('submit-r1-c0'), roundId: 'round-1', slot: 0, revision: pinOf('r0001'), evaluationId: 'r1-c0', edits: [{ asset: 'skill', target: 'count-letters' }], exploratory: false })
    await strategy.decideRound({ commandId: nextId('decide-round-1'), roundId: 'round-1' })
    const projected = projectRound(roundStateOf('round-1'), sliceOf(store.load()), FLOOR)
    const decision = roundStateOf('round-1').decision
    console.log(`  ..    incumbent ${baseline.quality} (${baselineVerdict.verdict}); model ${candidate.quality} (${candidateVerdict.verdict})`)
    check('the incumbent was measured on itself before the round opened, and its verdict is the verifier\'s',
      baseline.denominator === 2 && roundStateOf('round-1').plan.historyCutoff > baselineSeq && baselineVerdict.verdict === 'fail')
    check('the model\'s program was judged by the criterion\'s verifier, not by this file',
      candidateVerdict.verdict === (candidate.quality === 1 ? 'pass' : 'fail'))
    check('a candidate whose verifier failed does not enter the comparison, whatever it scored',
      decision.winner === (candidateVerdict.verdict === 'pass' ? 0 : null) && (candidateVerdict.verdict === 'pass' || projected.slots[0].admissible === false),
      `winner ${decision.winner}; ${projected.slots[0].reason ?? 'admitted'}`)

    // ---------------------------------------------------------------- 4. the pointer moves
    console.log('\n== the release path moves the head onto the elected revision, if one was elected')
    const pointerFacts = () => store.load().entriesOf(env.ENVIRONMENT_PROTOCOL, env.ENVIRONMENT_VERSION).filter(entry => entry.kind === env.ENVIRONMENT_KINDS.pointerSwitched)
    const headBefore = environmentOf().pointer
    if (decision.winner === null) {
      check('the round elected a revision, so there is something to move the head onto', false,
        `winner null: the model's program failed the verifier, so the pointer stays on ${JSON.stringify(headBefore)}`)
      console.log(`\nrsi-live: no candidate cleared round one; the head stayed on ${JSON.stringify(headBefore)}`)
      process.exitCode = 2
      return
    }
    approvalContext = await mountApprovalRuntime(sessions)
    const release = createReleaseCommands({ store, approvalSeams: { approval: approvalContext.ctx.approval, feed: approvalContext.ctx } })
    const handle = await approvalContext.ctx.agents.create({ sessionId: approvalContext.SessionId('rsi-live-approver'), meta: { cwd: root }, agentOptions: { provider: 'scripted', model: 'stub-1' } })
    let pending = null
    approvalContext.ctx.on('approval/request', async () => 'allowed-once')
    approvalContext.ctx.tools.register({
      name: 'rsi_approve',
      description: 'record a human authorisation of the drafted revision',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute: async (_args, exec) => {
        try {
          const envelope = await release.approve({
            commandId: pending.commandId, environmentId: ENVIRONMENT, revisionId: pending.revisionId,
            draftDigest: pending.draftDigest, approvedBy: 'human:alice',
            ask: { agent: exec.agent, toolName: 'rsi_approve', callId: exec.callId, reason: 'publishing this content is a decision' },
          })
          return { approved: true, approvalId: envelope.payload.approvalId }
        } catch (error) {
          const { ProtocolRefusal } = await import('../src/protocol/refusal.ts')
          if (error instanceof ProtocolRefusal) return { refused: error.refusal.code, detail: error.refusal.detail }
          throw error
        }
      },
    })
    const approveThroughTheSeam = async request => {
      pending = request
      const { createUserMessage } = await dshModule('@deepseek-ai/dsh-llm')
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'approve the drafted winner' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      return handle.agent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)?.data?.message?.content?.[0]?.text
    }
    await release.draft({ commandId: nextId('draft-r0001'), revision: pinOf('r0001') })
    const unapproved = await refusalOf(() => release.publish({ commandId: nextId('publish-unapproved'), environmentId: ENVIRONMENT, expected: headBefore, to: 'r0001' }))
    check('a drafted but unapproved revision cannot be published', unapproved.code === 'unapproved-revision', unapproved.code)
    const granted = JSON.parse(await approveThroughTheSeam({ commandId: nextId('approve-r0001'), revisionId: 'r0001', draftDigest: pinOf('r0001').digest }))
    check('the native ask granted once and the fact carries the audit id of the question that produced it', granted.approved === true && granted.approvalId !== undefined)
    await release.publish({ commandId: nextId('publish-r0001'), environmentId: ENVIRONMENT, expected: headBefore, to: 'r0001' })
    const headAfter = environmentOf().pointer
    check('the head moved onto the revision the round elected, by compare-and-swap on the head it replaced',
      headBefore !== headAfter && headAfter === 'r0001' && pointerFacts().length === 2 && pointerFacts().at(-1).payload.expected === headBefore,
      `${headBefore} -> ${headAfter} over ${pointerFacts().length} pointer fact(s)`)

    // The claim this file exists for, taken from the log rather than from local arithmetic.
    const measured = revisionId => {
      const opened = store.load().entriesOf(MEASURE_PROTOCOL, MEASURE_VERSION).filter(entry => entry.kind === 'evaluation/opened' && entry.payload.candidate?.revisionId === revisionId).at(-1)
      return opened === undefined ? null : projectEvaluation(measureStateOf(opened.subject)).quality
    }
    const verdictHeld = revisionId => {
      const where = revisionId === headBefore ? { taskId: TASK, runId: runOf('r1-baseline') } : { taskId: ATTEMPT1, runId: runOf('r1-c0') }
      return stateOfTask(where.taskId)?.runs[where.runId]?.evidence.find(entry => entry.criterionId === 'counted')?.verdict
    }
    check('the revision the pointer now names was passed by the verifier and the one it replaced was not',
      verdictHeld(headAfter) === 'pass' && verdictHeld(headBefore) === 'fail', `${verdictHeld(headBefore)} -> ${verdictHeld(headAfter)}`)
    check('the revision the pointer now names measured better than the one it replaced',
      measured(headAfter) > measured(headBefore), `${measured(headBefore)} -> ${measured(headAfter)}`)
    check('the constraint that admitted it cites the task protocol\'s own verdict digest for the bytes it measured',
      measureStateOf('r1-c0').checks[0].verdict.evidenceDigest === candidateVerdict.evidenceDigest &&
      measureStateOf('r1-c0').checks[0].verdict.artifactDigest === candidateVerdict.artifactDigest &&
      measureStateOf('r1-c0').checks[0].verdict.evidenceDigest === recordedVerdictDigest(stateOfTask(ATTEMPT1), 'recheck', { runId: runOf('r1-c0'), criterionId: 'counted', artifactDigest: candidateVerdict.artifactDigest }))
    // The citation is a binding, so both ways of citing the wrong thing have to be refused. The legs
    // carry evidence where the citation is the only defect, and a subject with no plan on purpose: the
    // payload is parsed before any plan is read, so what refuses them is the citation rule itself.
    const wrongBytes = await refusalOf(() => store.emit({
      commandId: nextId('check-wrong-bytes'), protocol: MEASURE_PROTOCOL, version: MEASURE_VERSION, kind: 'constraint/checked', subject: 'r1-c0',
      payload: {
        criterionId: 'bounded', met: true, artifactDigest: baselineVerdict.artifactDigest, verifierRef: BOUNDS, verifierVersion: '1', implementationDigest: boundsDigest,
        verdict: { criterionId: 'counted', evidenceDigest: candidateVerdict.evidenceDigest, artifactDigest: candidateVerdict.artifactDigest },
      },
    }))
    check('a citation of a verdict about other bytes than the ones measured is refused', wrongBytes.code === 'evidence-input-mismatch', wrongBytes.code)

    // ---------------------------------------------------------------- 5. round two reads round one
    console.log('\n== round two: the model sees what round one measured')
    const secondProgram = programOf(replayed === undefined
      ? await askModel('round-2 answer', [
        taskText,
        '## The input, exactly as it is on disk',
        `\`\`\`\n${inputText}\`\`\``,
        '## What happened when your previous program was judged',
        `The verifier recorded **${candidateVerdict.verdict}** on it${candidateVerdict.detail === undefined ? '' : `, saying: ${candidateVerdict.detail}`}.`,
        `The program the library had been on scored ${baseline.quality} and was ${baselineVerdict.verdict}.`,
        candidateVerdict.verdict === 'pass'
          ? 'It passed. Write the next program: if it cannot be improved on, repeat it unchanged.'
          : 'Write the next program, fixing whatever made the verifier fail it.',
      ].join('\n\n'))
      : await readFile(process.argv[replayIndex + 2], 'utf8'))
    await writeFile(programPathOf('r0002'), secondProgram, 'utf8')
    await store.emit({
      commandId: nextId('create-r0002'), protocol: env.ENVIRONMENT_PROTOCOL, version: env.ENVIRONMENT_VERSION,
      kind: env.ENVIRONMENT_KINDS.revisionCreated, subject: ENVIRONMENT,
      payload: { revisionId: 'r0002', manifest: { skills: [], tools: [PRODUCER], taskTemplates: [TASK], artifact: { file: 'artifacts/r0002.mjs', digest: sha256(await readFile(programPathOf('r0002'))) } } },
    })
    const secondBaselineVerdict = await produce(await beginRun('r2-baseline', TASK), headAfter)
    const secondBaseline = await measurementOf('r2-baseline', headAfter, headAfter, secondBaselineVerdict)
    const secondBaselineSeq = lastSeq()
    const secondVerdict = await produce(await beginRun('r2-c0', ATTEMPT2), 'r0002')
    const secondCandidate = await measurementOf('r2-c0', 'r0002', headAfter, secondVerdict)
    const roundOneDecisionSeq = store.load().entriesOf(STRATEGY_PROTOCOL, STRATEGY_VERSION).filter(entry => entry.subject === 'round-1' && entry.kind === 'round/decided')[0].seq
    await strategy.openRound({
      commandId: nextId('open-round-2'), roundId: 'round-2', round: 2, incumbent: pinOf(headAfter), candidates: 1, explorationSlots: 0,
      historyCutoff: store.load().entries().length, caliber: caliberDigestOf(measureStateOf('r2-baseline')),
      metric: { direction: metric.direction }, weights: WEIGHTS,
    })
    await strategy.submitCandidate({ commandId: nextId('submit-r2-c0'), roundId: 'round-2', slot: 0, revision: pinOf('r0002'), evaluationId: 'r2-c0', edits: [{ asset: 'skill', target: 'count-letters' }], exploratory: false })
    await strategy.decideRound({ commandId: nextId('decide-round-2'), roundId: 'round-2' })
    const decisionTwo = roundStateOf('round-2').decision
    console.log(`  ..    round two: model ${secondCandidate.quality} (${secondVerdict.verdict}) against the incumbent's ${secondBaseline.quality}`)
    check('round two\'s incumbent is the revision round one published, and its cutoff sits after that decision',
      roundStateOf('round-2').plan.incumbent.revisionId === headAfter && roundStateOf('round-2').plan.historyCutoff > roundOneDecisionSeq && roundStateOf('round-2').plan.historyCutoff > secondBaselineSeq)
    check('the second program was judged the same way, under the same context and the same criterion',
      measureStateOf('r2-c0').baseline.revisionId === headAfter && measureStateOf('r2-c0').observed.length === 2 &&
      contextDigestOf(bubbleIn(measureStateOf('r2-c0').run)) === contextDigestOf(bubbleIn(measureStateOf('r1-c0').run)))
    // What the round *should* do is the projection's answer, not this file's. A program the verifier
    // passed can still fail to clear the round's floor — a repeat that measures the same is not an
    // improvement — so "it passed, therefore it won" would be this file inventing a rule.
    const projectedTwo = projectRound(roundStateOf('round-2'), sliceOf(store.load()), FLOOR)
    check('round two\'s decision is the projection, and a program that only repeated the incumbent did not win',
      decisionTwo.winner === projectedTwo.winner && (secondVerdict.verdict === 'pass' || decisionTwo.winner === null),
      `verdict ${secondVerdict.verdict}, winner ${decisionTwo.winner}, projected ${projectedTwo.winner}`)
    if (decisionTwo.winner === 0) {
      await release.draft({ commandId: nextId('draft-r0002'), revision: pinOf('r0002') })
      const grantedTwo = JSON.parse(await approveThroughTheSeam({ commandId: nextId('approve-r0002'), revisionId: 'r0002', draftDigest: pinOf('r0002').digest }))
      check('round two\'s winner was approved through the same seam before its head could move', grantedTwo.approved === true && grantedTwo.approvalId !== undefined)
      await release.publish({ commandId: nextId('publish-r0002'), environmentId: ENVIRONMENT, expected: headAfter, to: 'r0002' })
      check('the second improvement moved the head too, onto a revision the verifier passed',
        environmentOf().pointer === 'r0002' && pointerFacts().length === 3, `${headAfter} -> ${environmentOf().pointer}`)
    } else check('round two kept the incumbent, so the head did not move a second time', pointerFacts().length === 2)

    // ---------------------------------------------------------------- 5.5 the plan and the receipt
    console.log('\n== the plan and the receipt: where the model worked, and what its run leaves behind')
    const held = store.load().entries()
    const tree = projectTree(foldSubjects(registry, held, TASK_PROTOCOL, TASK_VERSION)).find(view => view.parentTaskId === TASK)
    check('the campaign ran inside a plan: two delegated attempts, the second depending on the first',
      tree !== undefined && tree.children.map(child => child.taskId).join(',') === `${ATTEMPT1},${ATTEMPT2}` &&
      tree.children[1].dependsOn.join(',') === ATTEMPT1 && tree.children[1].runsUsed === 1)
    check('the first attempt supports the root criterion without replacing its independent verdict',
      tree?.criteria.find(entry => entry.criterionId === 'counted')?.supportedBy.includes(ATTEMPT1) && tree?.criteria.find(entry => entry.criterionId === 'counted')?.satisfiedBy === null,
      String(tree?.criteria.find(entry => entry.criterionId === 'counted')?.satisfiedBy))
    // The receipt is derived twice from the committed prefix — once from the prefix that ends at the
    // settlement (round two's facts are not in it) and once from the whole log — and both derivations
    // read the same verdict fact the constraint cited. That is the merge this campaign exists for:
    // one judgment, one fact, two readers that cannot disagree.
    const settleAt = held.findIndex(entry => entry.kind === TASK_KINDS.runVerified && entry.subject === ATTEMPT1)
    const settledPrefix = held.slice(0, settleAt + 1)
    const receiptAtSettlement = projectReceipt(registry, settledPrefix, ATTEMPT1, runOf('r1-c0'))
    const receipt = projectReceipt(registry, held, ATTEMPT1, runOf('r1-c0'))
    check('the model\'s run settled inside its sub-task, and its receipt derives from the prefix that ends at the settlement',
      receiptAtSettlement.status === 'verified' && receiptAtSettlement.cutoff === settledPrefix.length &&
      receipt.status === 'verified' && receipt.cutoff === held.length)
    check('the receipt and the constraint cite the same verdict: the same bytes, the same digest, one fact',
      receiptAtSettlement.criteria[0].artifactDigest === candidateVerdict.artifactDigest &&
      receiptAtSettlement.criteria[0].verdict === 'pass' &&
      receiptAtSettlement.consumption.basis === 'judged' && JSON.stringify(receiptAtSettlement.consumption.inputs) === JSON.stringify(INPUTS) &&
      measureStateOf('r1-c0').checks[0].verdict.artifactDigest === receiptAtSettlement.criteria[0].artifactDigest &&
      measureStateOf('r1-c0').checks[0].verdict.evidenceDigest === recordedVerdictDigest(stateOfTask(ATTEMPT1), 'the receipt\'s verdict', { runId: runOf('r1-c0'), criterionId: 'counted', artifactDigest: receiptAtSettlement.criteria[0].artifactDigest }))
    const secondReceipt = projectReceipt(registry, held, ATTEMPT2, runOf('r2-c0'))
    check('each subtree holds one model run and one receipt, and the second reads the second verdict',
      secondReceipt.status === (secondVerdict.verdict === 'pass' ? 'verified' : 'failed') &&
      secondReceipt.criteria[0].artifactDigest === secondVerdict.artifactDigest)

    // ---------------------------------------------------------------- 6. the log explains itself
    console.log('\n== the log explains itself')
    await store.close()
    const reopened = await ControlSessionStore.open({ persistence: live.persistence, controlId: CONTROL, registry, subjects, cwd: workspace })
    const afterReopen = reopened.load()
    check('reopening the session reproduces the same head and both decisions',
      afterReopen.stateOf(env.ENVIRONMENT_PROTOCOL, env.ENVIRONMENT_VERSION, ENVIRONMENT).pointer === environmentOf().pointer &&
      afterReopen.stateOf(STRATEGY_PROTOCOL, STRATEGY_VERSION, 'round-1').decision.winner === 0 &&
      afterReopen.stateOf(STRATEGY_PROTOCOL, STRATEGY_VERSION, 'round-2').decision.winner === decisionTwo.winner)
    check('reopening reproduces the receipt: the same prefix, the same digest',
      receiptDigest(projectReceipt(registry, afterReopen.entries(), ATTEMPT1, runOf('r1-c0'))) === receiptDigest(receipt))
    check('every model answer came from the deployment\'s own route, and no answer is in the log',
      calls.every(call => /^[0-9a-f]{64}$/.test(call.digest)) &&
      !afterReopen.entries().some(entry => calls.some(call => JSON.stringify(entry.payload).includes(call.reply.slice(0, 40)))),
      `${calls.length} call(s) on ${model.route.provider}`)
    check('the verdict is recorded once, in the task protocol, and the measurement holds a citation of it',
      stateOfTask(ATTEMPT1).runs[runOf('r1-c0')].evidence.length === 1 &&
      measureStateOf('r1-c0').checks[0].verdict.evidenceDigest === candidateVerdict.evidenceDigest)
    await reopened.close()
  } finally {
    await model.dispose().catch(() => {})
    await live.context.fiber.dispose().catch(() => {})
    await approvalContext?.ctx.fiber.dispose().catch(() => {})
    if (process.env['RSI_LIVE_KEEP'] === '1') console.log(`kept: ${root}`)
    else await rm(root, { recursive: true, force: true })
  }

  console.log(`\nrsi-live: ${checks} check(s), ${failures.length} failed, ${refusals} refusal(s) observed`)
  if (failures.length > 0) {
    for (const label of failures) console.log(`  FAIL  ${label}`)
    process.exit(1)
  }
  console.log('rsi-live: OK — a real model wrote the artifact inside a decomposed sub-task, a real verifier judged it, the receipt and the measurement cite the same verdict, and the pointer moved onto a revision that measured better')
}

/**
 * The runtime the native approval seam needs: the service, the append feed, and enough of an agent loop
 * to drive one tool call. The adapter is scripted — the approver is not the subject of this probe, and
 * a person is not in this process, so what is observed is the seam's plumbing, not a decision.
 */
async function mountApprovalRuntime(root) {
  const { Context } = await dshModule('@deepseek-ai/cordis')
  const { default: JsonlSessionPersistence } = await dshModule('@deepseek-ai/dsh-session-persistence-jsonl')
  const { SessionStore, SessionId } = await dshModule('@deepseek-ai/dsh-session')
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
  await ctx.plugin(approval.default, {})

  class Scripted extends LlmAdapter {
    constructor() {
      super()
      this.step = 0
    }
    async *stream() {
      this.step += 1
      const id = `call-${this.step}`
      if (this.step % 2 === 1) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'rsi_approve', argumentsDelta: '{}' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'rsi_approve', arguments: '{}' } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['scripted'], new Scripted())
  return { ctx, SessionId }
}

main().catch(error => {
  console.error(`rsi-live: ${error?.stack ?? error}`)
  process.exit(1)
})

#!/usr/bin/env node
/**
 * S6 — SIGKILL at the execution and the settlement boundary, observed in real processes.
 */

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openPersistence } from './dsh-control-runtime.mjs'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import { declareTaskProtocol, TASK_PROTOCOL, TASK_VERSION, verifierRoleOf } from '../src/task/protocol.ts'
import { declareEnvironmentProtocol, ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION } from '../src/environment/protocol.ts'
import { declareAgentProtocol, AGENT_PROTOCOL, AGENT_VERSION } from '../src/agent/protocol.ts'
import { projectTree } from '../src/task/tree.ts'
import { foldSubjects } from '../src/protocol/fold.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ADAPTER = join(HERE, 'verifier-command.mjs')

const PARENT_TASK = 'task-recover'
const CHILD = 'task-recover-child'
const AGENT = 'agent-worker'
const ENVIRONMENT = 'library-1'
const REVISION = 'r0001'
const RUN = 'run-1'
const CONTROL = 'recovery'
const VERIFIER = 'command'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const shellQuote = value => `'${String(value).replaceAll("'", `'\\''`)}'`
const shellLine = argv => argv.map(shellQuote).join(' ')
const line = value => console.log(JSON.stringify(value))

const WORDS = 'alpha beta gamma delta\n'
const VERIFY_PROGRAM = `import { readFileSync } from 'node:fs'
const [input, artifact] = process.argv.slice(2)
const words = readFileSync(input, 'utf8').trim().split(/\\s+/).filter(Boolean).length
const claimed = Number(readFileSync(artifact, 'utf8').trim())
process.exit(claimed === words ? 0 : 1)
`
const PRODUCE_PROGRAM = `import { readFileSync, writeFileSync } from 'node:fs'
const [input, artifact] = process.argv.slice(2)
const words = readFileSync(input, 'utf8').trim().split(/\\s+/).filter(Boolean).length
writeFileSync(artifact, String(words))
`

const paths = root => ({
  workspace: join(root, 'workspace'),
  sessions: join(root, 'sessions'),
  input: join(root, 'workspace', 'words.txt'),
  verify: join(root, 'workspace', 'verify-count.mjs'),
  produce: join(root, 'workspace', 'produce-count.mjs'),
  artifact: join(root, 'workspace', 'count.txt'),
})

/** The deployment: real files, a real session store, the three protocols. */
async function deployment(root) {
  const at = paths(root)
  const { ControlSessionStore } = await import('../src/control/session-store.ts')
  const { createTaskCommands } = await import('../src/task/commands.ts')

  const programDigest = sha256(await readFile(at.verify))
  const registry = new ProtocolRegistry()
  declareTaskProtocol(registry)
  declareEnvironmentProtocol(registry)
  declareAgentProtocol(registry)

  const live = await openPersistence(at.sessions)
  const store = await ControlSessionStore.open({
    persistence: live.persistence,
    controlId: CONTROL,
    registry,
    subjects: {
      scheduler: 'runtime-1',
      [verifierRoleOf({ verifierRef: VERIFIER, verifierVersion: '1' })]: 'command-verifier-service',
      environment: 'environment-service',
      runtime: 'runtime-service',
    },
    cwd: at.workspace,
  })

  const commands = createTaskCommands({
    store,
    registry,
    agents: new Map([[AGENT, { as: 'scheduler' }]]),
    implementations: [{ ref: VERIFIER, version: '1', implementationDigest: programDigest }],
  })
  return { at, store, live, registry, commands, programDigest }
}

const criterion = programDigest => ({
  criterionId: 'counted',
  statement: 'the artifact holds the count',
  verifierRef: VERIFIER,
  verifierVersion: '1',
  implementationDigest: programDigest,
})

/**
 * Every fact that makes up the attempt, emitted through the command boundary with fixed command
 */
async function bootstrap({ at, store, commands, programDigest }) {
  const { ENVIRONMENT_KINDS } = await import('../src/environment/protocol.ts')
  const { AGENT_KINDS } = await import('../src/agent/protocol.ts')

  await store.emit({
    commandId: 'open-agent',
    protocol: AGENT_PROTOCOL,
    version: AGENT_VERSION,
    kind: AGENT_KINDS.opened,
    subject: AGENT,
    payload: { agentId: AGENT, role: 'worker', sessionId: 'singularity:agent:recovery' },
  })
  await store.emit({
    commandId: 'create-revision',
    protocol: ENVIRONMENT_PROTOCOL,
    version: ENVIRONMENT_VERSION,
    kind: ENVIRONMENT_KINDS.revisionCreated,
    subject: ENVIRONMENT,
    payload: { revisionId: REVISION, manifest: { skills: ['count-words'] } },
  })

  const contract = { goal: 'count the words', inputs: ['words.txt'], criteria: [criterion(programDigest)] }
  await commands.admit({ commandId: 'admit-parent', taskId: PARENT_TASK, contract: { ...contract, goal: 'report the count' } })
  await commands.admit({ commandId: 'admit-child', taskId: CHILD, contract })
  await commands.decompose({
    commandId: 'plan',
    parentTaskId: PARENT_TASK,
    children: [{ taskId: CHILD, dependsOn: [], supports: ['counted'], maxRuns: 2 }],
  })
  await commands.assign({ commandId: 'assign-parent', taskId: PARENT_TASK, agentId: AGENT })
  await commands.assign({ commandId: 'assign-child', taskId: CHILD, agentId: AGENT })

  const digest = store.load().stateOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT).revisions[REVISION].contentDigest
  const pin = { environmentId: ENVIRONMENT, revisionId: REVISION, digest }
  await commands.startRun({ commandId: 'start-run', taskId: CHILD, runId: RUN, revision: pin })
  const inputDigest = sha256(await readFile(at.input))
  await commands.openBubble({
    commandId: 'open-bubble',
    taskId: CHILD,
    runId: RUN,
    inputs: [{ name: 'words.txt', digest: inputDigest }],
    workspace: { kind: 'dir', ref: at.workspace },
    // The isolation manifest: the model identity and the tool digests this execution could reach.
    // A bubble that cannot say what its tools were is not a reproducible context, so it is required.
    model: 'probe-model-1',
    tools: [{ name: 'count', implementationDigest: programDigest, version: '1' }],
    conditions: ['no-network'],
  })
  return { pin, inputs: [{ name: 'words.txt', digest: inputDigest }] }
}

/** Produce the artifact by running a real program, then form a verdict by running the verifier. */
async function decide({ at, programDigest }) {
  const produced = spawnSync(process.execPath, [at.produce, at.input, at.artifact], { encoding: 'utf8' })
  if (produced.status !== 0) throw new Error(`the attempt could not produce the artifact: ${produced.stderr}`)
  const judged = spawnSync(
    process.execPath,
    [ADAPTER, JSON.stringify({ command: shellLine([process.execPath, at.verify, at.input, at.artifact]), artifactPath: at.artifact, inputs: [] })],
    { encoding: 'utf8' },
  )
  if (judged.status !== 0) throw new Error(`the verifier could not judge: ${judged.stderr}`)
  const [line_] = judged.stdout.trimEnd().split('\n')
  const verdict = JSON.parse(line_)
  return {
    runId: RUN,
    criterionId: 'counted',
    verdict: verdict.verdict,
    implementationDigest: programDigest,
    artifactDigest: sha256(await readFile(at.artifact)),
    inputDigests: [{ name: 'words.txt', digest: sha256(await readFile(at.input)) }],
    detail: verdict.detail,
  }
}

const factReport = store => ({
  facts: store.load().entries().map(entry => ({
    kind: entry.kind,
    subject: entry.subject,
    digest: entry.digest,
    commandId: entry.commandId,
  })),
})

// ---------------------------------------------------------------------------- the holder child
async function hold(root, phase) {
  const live = await deployment(root)
  const started = Date.now()
  const { pin, inputs } = await bootstrap(live)
  const verdict = await decide(live)
  if (phase === 'settlement')
    await live.commands.recordVerdict({ commandId: 'record-verdict', taskId: CHILD, verdict })

  line({
    event: 'holding',
    phase,
    pid: process.pid,
    sessionId: String(live.store.sessionId),
    startedIn: Date.now() - started,
    // What the dead process bound its work to, so the successor's reading can be compared with it
    // rather than merely inspected.
    pin,
    inputs,
    verdict,
    ...factReport(live.store),
  })

  // Hold the write lease until the parent kills this process.
  await new Promise(() => {})
}

// ---------------------------------------------------------------------------- the parent
async function probe() {
  const failures = []
  const check = (label, condition, detail) => {
    if (condition) console.log(`  ok    ${label}`)
    else {
      failures.push(label)
      console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
    }
  }

  // Each boundary gets its own session. Sharing one would conflate two scenarios: the execution
  // phase settles its attempt, so a settlement phase on the same facts would be re-deciding work
  // that was already decided - which the log refuses, correctly, as a command conflict.
  for (const phase of ['execution', 'settlement']) {
    const root = await mkdtemp(join(tmpdir(), `singularity-recovery-${phase}-`))
    const at = paths(root)
    try {
      await mkdir(at.workspace, { recursive: true })
      await mkdir(at.sessions, { recursive: true })
      await writeFile(at.input, WORDS, 'utf8')
      await writeFile(at.verify, VERIFY_PROGRAM, 'utf8')
      await writeFile(at.produce, PRODUCE_PROGRAM, 'utf8')

      console.log(`\n== the ${phase} boundary ==`)
      const holder = spawn(process.execPath, [fileURLToPath(import.meta.url), '--hold', root, phase], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      holder.stdout.on('data', chunk => (stdout += String(chunk)))
      holder.stderr.on('data', chunk => (stderr += String(chunk)))

      const reported = await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`the holder never reported: ${stderr.slice(-400)}`)), 30000)
        holder.stdout.on('data', () => {
          const found = stdout
            .split('\n')
            .filter(entry => entry.trim() !== '')
            .map(entry => {
              try {
                return JSON.parse(entry)
              } catch {
                return null
              }
            })
            .find(entry => entry?.event === 'holding')
          if (found !== undefined) {
            clearTimeout(deadline)
            resolve(found)
          }
        })
        holder.on('exit', code => {
          clearTimeout(deadline)
          reject(new Error(`the holder exited early (${code}): ${stderr.slice(-400)}`))
        })
      })

      const killedAt = Date.now()
      holder.kill('SIGKILL')
      await new Promise(resolve => holder.on('exit', resolve))
      console.log(`  holder pid ${reported.pid} killed at the ${phase} boundary; it had committed ${reported.facts.length} facts`)

      // A new process, the same control id: the successor must take over the same session.
      const live = await deployment(root)
      const tookOverIn = Date.now() - killedAt
      check('the successor takes over the write lease immediately after the kill', tookOverIn < 5000, `${tookOverIn}ms`)
      check('the successor is the same control session', String(live.store.sessionId) === reported.sessionId, String(live.store.sessionId))

      const successor = factReport(live.store)
      check(
        'every fact the dead process committed is readable, and nothing was added or altered',
        successor.facts.length >= reported.facts.length &&
          reported.facts.every((fact, index) => successor.facts[index]?.digest === fact.digest && successor.facts[index]?.kind === fact.kind),
        `${reported.facts.length} then ${successor.facts.length}`,
      )

      // The bindings survived: same responsibility, same pin, same declared inputs.
      const cut = live.store.load()
      const task = cut.stateOf(TASK_PROTOCOL, TASK_VERSION, CHILD)
      check('the responsibility survived the kill', task?.responsibility?.agentId === AGENT && task?.responsibility?.agentIdentity === 'runtime-1')
      // Field for field against two independent readings: what the dead process pinned, and what the
      // environment the successor adopted actually recorded. "a run exists" is not this check - a run
      // whose pin was dropped, or re-pointed at other content, is exactly what it has to catch.
      const recorded = cut.stateOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT)?.revisions?.[REVISION]
      const revision = task?.runs?.[RUN]?.revision
      check(
        'the revision pin survived the kill, field for field',
        JSON.stringify(revision) === JSON.stringify(reported.pin) && revision?.digest === recorded?.contentDigest,
        `read ${JSON.stringify(revision ?? null)}; the dead process pinned ${JSON.stringify(reported.pin)}; the environment records ${JSON.stringify(recorded?.contentDigest ?? null)}`,
      )
      check('the declared inputs survived the kill', JSON.stringify(task?.runs?.[RUN]?.bubble?.inputs) === JSON.stringify(reported.inputs))

      // Re-driving the setup must replay, not repeat: the same command ids are already committed.
      const before = successor.facts.length
      const { pin, inputs } = await bootstrap(live)
      check('re-driving a committed command replays it instead of appending a second fact', factReport(live.store).facts.length === before, `${before} then ${factReport(live.store).facts.length}`)

      if (phase === 'execution') {
        // The dead process decided nothing: the successor completes the work.
        check('nothing was decided before the kill', task?.runs?.[RUN]?.evidence?.length === 0, JSON.stringify(task?.runs?.[RUN]?.evidence))
        const verdict = await decide(live)
        await live.commands.recordVerdict({ commandId: 'record-verdict', taskId: CHILD, verdict })
        await live.store.emit({ commandId: 'verify-run', protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'run/verified', subject: CHILD, payload: { runId: RUN } })
        const settled = live.store.load().stateOf(TASK_PROTOCOL, TASK_VERSION, CHILD)
        check('the successor finished the attempt exactly once', settled?.runs?.[RUN]?.evidence?.length === 1 && settled?.runs?.[RUN]?.status === 'verified')
        void pin
        void inputs
      } else {
        // The verdict was committed before the kill: it must be there once, and re-delivering its
        // command must return that fact rather than deciding anything again.
        const committed = task?.runs?.[RUN]?.evidence ?? []
        check('the verdict committed before the kill is there exactly once', committed.length === 1, JSON.stringify(committed.map(entry => entry.criterionId)))
        check('the committed verdict kept the artifact it was formed on', committed[0]?.artifactDigest === reported.verdict.artifactDigest)

        const replay = await live.commands.recordVerdict({ commandId: 'record-verdict', taskId: CHILD, verdict: reported.verdict })
        const afterReplay = live.store.load().stateOf(TASK_PROTOCOL, TASK_VERSION, CHILD)
        check('re-delivering the verdict command returns the committed fact without a second one', (afterReplay?.runs?.[RUN]?.evidence ?? []).length === 1)
        check('the replayed fact is the one the dead process committed', afterReplay?.runs?.[RUN]?.evidence?.[0]?.artifactDigest === reported.verdict.artifactDigest)
        void replay
        void pin
        void inputs

        await live.store.emit({ commandId: 'verify-run', protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'run/verified', subject: CHILD, payload: { runId: RUN } })
        const settled = live.store.load().stateOf(TASK_PROTOCOL, TASK_VERSION, CHILD)
        check('the successor settles the run without creating a second attempt', Object.keys(settled?.runs ?? {}).length === 1 && settled?.runs?.[RUN]?.status === 'verified')
      }

      // And the plan agrees, from the facts alone.
      const tree = projectTree(foldSubjects(live.registry, live.store.load().entries(), TASK_PROTOCOL, TASK_VERSION))[0]
      check('the plan reports the sub-task verified and the criterion accepted', tree?.children[0]?.status === 'verified' && tree?.criteria[0]?.satisfiedBy === CHILD)

      await live.store.close()
      await live.live.context.fiber.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }

  console.log('')
  if (failures.length > 0) {
    console.error(`recovery-probe: ${failures.length} check(s) failed: ${failures.join(' | ')}`)
    process.exitCode = 1
  } else {
    console.log('recovery-probe: OK — both boundaries recovered the same attempt without duplicating it')
  }
}

if (process.argv[2] === '--hold') await hold(process.argv[3], process.argv[4])
else await probe()

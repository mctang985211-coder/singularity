#!/usr/bin/env node
/**
 * S6 — the real root/child vertical slice, with a real verifier on a real artifact.
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openPersistence } from './dsh-control-runtime.mjs'
import { ProtocolRegistry } from '../src/protocol/registry.ts'
import { ProtocolRefusal } from '../src/protocol/refusal.ts'
import { declareTaskProtocol, TASK_KINDS, TASK_PROTOCOL, TASK_VERSION } from '../src/task/protocol.ts'
import { declareEnvironmentProtocol, ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION } from '../src/environment/protocol.ts'
import { declareAgentProtocol, AGENT_PROTOCOL, AGENT_VERSION } from '../src/agent/protocol.ts'
import { createTaskCommands } from '../src/task/commands.ts'
import { runProductionVerdict } from '../src/verifier/production.ts'
import { projectTask, projectReceipt, receiptDigest } from '../src/task/view.ts'
import { projectTree } from '../src/task/tree.ts'
import { foldSubjects } from '../src/protocol/fold.ts'
import { verifierRoleOf } from '../src/task/protocol.ts'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ADAPTER = join(HERE, 'verifier-command.mjs')

const PARENT = 'task-report'
const CHILD_COUNT = 'task-count'
const CHILD_LIMITS = 'task-limits'
const AGENT = 'agent-worker'
const ENVIRONMENT = 'library-1'
const REVISION = 'r0001'
const VERIFIER = 'command'

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`  ok    ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const TEMPLATE = { id: 'root-child-probe', digest: sha256(await readFile(new URL(import.meta.url))) }

/** The adapter executes a shell line, so every path in it is quoted rather than pasted. */
const shellQuote = value => `'${String(value).replaceAll("'", `'\\''`)}'`
const shellLine = argv => argv.map(shellQuote).join(' ')

function refusalOf(run) {
  try {
    run()
  } catch (error) {
    if (error instanceof ProtocolRefusal) return error.refusal
    throw error
  }
  throw new Error('expected a refusal')
}

async function asyncRefusalOf(run) {
  try {
    await run()
  } catch (error) {
    if (error instanceof ProtocolRefusal) return error.refusal
    throw error
  }
  throw new Error('expected a refusal')
}

/** The program that decides: it exits 0 exactly when the artifact holds the input's word count. */
const VERIFY_PROGRAM = `import { readFileSync } from 'node:fs'
const [input, artifact] = process.argv.slice(2)
const words = readFileSync(input, 'utf8').trim().split(/\\s+/).filter(Boolean).length
const claimed = Number(readFileSync(artifact, 'utf8').trim())
if (!Number.isInteger(claimed)) process.exit(2)
process.exit(claimed === words ? 0 : 1)
`

/** The program the attempt runs: it writes the count, with an offset so a wrong answer is easy. */
const PRODUCE_PROGRAM = `import { readFileSync, writeFileSync } from 'node:fs'
const [input, artifact, offset] = process.argv.slice(2)
const words = readFileSync(input, 'utf8').trim().split(/\\s+/).filter(Boolean).length
writeFileSync(artifact, String(words + Number(offset ?? 0)))
`

/** Spawn the real adapter, which runs the command and hashes the artifact afterwards. */
function runAdapter(request) {
  const result = spawnSync(process.execPath, [ADAPTER, JSON.stringify(request)], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`the adapter could not judge: ${result.stderr}`)
  const [line] = result.stdout.trimEnd().split('\n')
  return JSON.parse(line)
}

async function main() {
  // Resolved dynamically, after `dsh-control-runtime` has registered its resolve hook. ESM links
  // static imports before evaluating any of them, so a hook registered during evaluation is too
  // late for a static import of a module that names a DSH package.
  const { ControlSessionStore } = await import('../src/control/session-store.ts')

  const root = await mkdtemp(join(tmpdir(), 'singularity-slice-b-'))
  const workspace = join(root, 'workspace')
  const sessions = join(root, 'sessions')
  await writeFile(join(root, 'placeholder'), '')
  await rm(join(root, 'placeholder'))

  const { mkdir } = await import('node:fs/promises')
  await mkdir(workspace, { recursive: true })
  await mkdir(sessions, { recursive: true })

  try {
    // ---------------------------------------------------------------- the real workspace
    const inputPath = join(workspace, 'words.txt')
    const verifyPath = join(workspace, 'verify-count.mjs')
    const producePath = join(workspace, 'produce-count.mjs')
    const artifactPath = join(workspace, 'count.txt')
    await writeFile(inputPath, 'alpha beta gamma delta\n', 'utf8')
    await writeFile(verifyPath, VERIFY_PROGRAM, 'utf8')
    await writeFile(producePath, PRODUCE_PROGRAM, 'utf8')

    const inputDigest = sha256(await readFile(inputPath))
    const programDigest = sha256(await readFile(verifyPath))
    const INPUTS = [{ name: 'words.txt', digest: inputDigest }]

    // ---------------------------------------------------------------- the deployment
    const registry = new ProtocolRegistry()
    declareTaskProtocol(registry)
    declareEnvironmentProtocol(registry)
    declareAgentProtocol(registry)

    const SUBJECTS = {
      scheduler: 'runtime-1',
      [verifierRoleOf({ verifierRef: VERIFIER, verifierVersion: '1' })]: 'command-verifier-service',
      environment: 'environment-service',
      runtime: 'runtime-service',
    }

    const live = await openPersistence(sessions)
    const store = await ControlSessionStore.open({
      persistence: live.persistence,
      controlId: 'slice-b',
      registry,
      subjects: SUBJECTS,
      cwd: workspace,
    })

    console.log(`session ${store.sessionId}`)

    // The agent node references a session; the revision is created through its own protocol.
    await store.emit({
      commandId: 'open-agent',
      protocol: AGENT_PROTOCOL,
      version: AGENT_VERSION,
      kind: 'agent/opened',
      subject: AGENT,
      payload: { agentId: AGENT, role: 'worker', sessionId: 'singularity:agent:slice-b' },
    })
    await store.emit({
      commandId: 'create-revision',
      protocol: ENVIRONMENT_PROTOCOL,
      version: ENVIRONMENT_VERSION,
      kind: 'revision/created',
      subject: ENVIRONMENT,
      payload: { revisionId: REVISION, manifest: { skills: ['count-words'], taskTemplates: [] } },
    })
    const revisionDigest = store.load().stateOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, ENVIRONMENT).revisions[REVISION].contentDigest

    const commands = createTaskCommands({
      store,
      registry,
      agents: new Map([[AGENT, { as: 'scheduler' }]]),
      implementations: [{ ref: VERIFIER, version: '1', implementationDigest: programDigest }],
    })

    const criterion = (criterionId, statement) => ({
      criterionId,
      statement,
      verifierRef: VERIFIER,
      verifierVersion: '1',
      implementationDigest: programDigest,
    })

    await commands.admit({
      commandId: 'admit-parent',
      taskId: PARENT,
      contract: {
        goal: 'report the word count of the fixture',
        template: TEMPLATE,
        inputs: [{ name: 'words.txt', source: { kind: 'protected', ref: 'words', digest: inputDigest } }],
        criteria: [criterion('counted', 'the artifact holds the fixture\'s word count'), criterion('bounded', 'the artifact rejects an oversized input')],
      },
    })
    await commands.admit({
      commandId: 'admit-count',
      taskId: CHILD_COUNT,
      contract: { goal: 'count the words', template: TEMPLATE, inputs: [{ name: 'words.txt', source: { kind: 'protected', ref: 'words', digest: inputDigest } }], criteria: [criterion('counted', 'the artifact holds the count')] },
    })
    await commands.admit({
      commandId: 'admit-limits',
      taskId: CHILD_LIMITS,
      contract: { goal: 'bound the input size', template: TEMPLATE, inputs: [{ name: 'words.txt', source: { kind: 'protected', ref: 'words', digest: inputDigest } }], criteria: [criterion('bounded', 'the artifact refuses oversized input')] },
    })

    // A plan: counting first, then the limit check, each supporting one criterion of the parent.
    // The parent is assigned first, because a plan is the holder's act.
    await commands.assign({ commandId: 'assign-parent', taskId: PARENT, agentId: AGENT })
    await commands.decompose({
      commandId: 'plan',
      parentTaskId: PARENT,
      children: [
        { taskId: CHILD_COUNT, dependsOn: [], supports: ['counted'], maxRuns: 1 },
        { taskId: CHILD_LIMITS, dependsOn: [CHILD_COUNT], supports: ['bounded'], maxRuns: 1 },
      ],
    })
    await commands.assign({ commandId: 'assign-count', taskId: CHILD_COUNT, agentId: AGENT })
    await commands.assign({ commandId: 'assign-limits', taskId: CHILD_LIMITS, agentId: AGENT })

    const pin = { environmentId: ENVIRONMENT, revisionId: REVISION, digest: revisionDigest }
    const treeOf = () => projectTree(foldSubjects(registry, store.load().entries(), TASK_PROTOCOL, TASK_VERSION))

    // ---------------------------------------------------------------- 1. the dependency gates
    const tooEarly = await asyncRefusalOf(() => commands.startRun({ commandId: 'early', taskId: CHILD_LIMITS, runId: 'run-limits', revision: pin }))
    check('a sub-task cannot start before the one it depends on has verified', tooEarly.code === 'illegal-transition' && tooEarly.detail.includes(CHILD_COUNT), tooEarly.code)
    const limitsEarly = treeOf()[0].children.find(child => child.taskId === CHILD_LIMITS)
    check('the plan reports the dependent as waiting, not ready', limitsEarly?.status === 'waiting', limitsEarly?.status)
    check('the refusal quotes the plan and names the dependency', (tooEarly.detail ?? '').includes(`"${CHILD_COUNT}"`), tooEarly.detail)

    // ---------------------------------------------------------------- 2. a real run and verdict
    await commands.startRun({ commandId: 'start-count', taskId: CHILD_COUNT, runId: 'run-count', revision: pin })
    await commands.openBubble({
      commandId: 'bubble-count',
      taskId: CHILD_COUNT,
      runId: 'run-count',
      inputs: INPUTS,
      workspace: { kind: 'dir', ref: workspace },
      // The isolation manifest R08 requires: the model identity and the content digest of every
      // tool the execution could reach. A tool's name can be re-pointed; its digest cannot.
      model: 'probe-model-1',
      tools: [{ name: 'count', implementationDigest: programDigest, version: '1' }],
      conditions: ['no-network'],
    })

    // The attempt produces the artifact by running a real program; the verifier then judges it.
    const produced = spawnSync(process.execPath, [producePath, inputPath, artifactPath, '0'], { encoding: 'utf8' })
    check('the attempt produced the artifact by running a program', produced.status === 0, produced.stderr)

    const judge = async execution => {
      const judged = runAdapter({
        command: shellLine([process.execPath, verifyPath, inputPath, execution.artifactPath]),
        artifactPath: execution.artifactPath,
        inputs: execution.inputs.map(entry => ({ name: entry.name, digest: entry.digest, path: entry.path })),
      })
      // The digest of the program that actually ran, read from its bytes at judgement time.
      return { verdict: judged.verdict, implementationDigest: sha256(await readFile(verifyPath)), detail: judged.detail }
    }

    const implementation = {
      ref: VERIFIER,
      version: '1',
      implementationDigest: programDigest,
      selftest: {
        samples: [
          { name: 'accepts a correct count', expected: 'pass', input: { subject: inputPath, artifactDigest: sha256('4'), inputs: [] } },
          { name: 'rejects a wrong count', expected: 'fail', input: { subject: inputPath, artifactDigest: sha256('5'), inputs: [] } },
        ],
      },
      judge: async sample => {
        const scratch = join(workspace, `sample-${sha256(sample.subject + String(sample.artifactDigest)).slice(0, 8)}.txt`)
        const isGood = sample.artifactDigest === sha256('4')
        await writeFile(scratch, isGood ? '4' : '5', 'utf8')
        const judged = runAdapter({
          command: shellLine([process.execPath, verifyPath, sample.subject, scratch]),
          artifactPath: scratch,
          inputs: [],
        })
        return { verdict: judged.verdict, detail: judged.detail }
      },
    }

    const ARTIFACT_NAME = 'count.txt'
    const verdictFor = async () =>
      runProductionVerdict({
        runId: 'run-count',
        criterion: criterion('counted', 'the artifact holds the count'),
        implementations: [implementation],
        inputs: INPUTS,
        workspace,
        // A declared name, resolved inside the workspace by the production path itself.
        artifactPath: ARTIFACT_NAME,
        command: [process.execPath, verifyPath, inputPath, artifactPath],
        runJudge: judge,
      })

    const verdict = await verdictFor()
    check('the verifier judged by running a program, and passed a correct artifact', verdict.verdict === 'pass', verdict.detail)
    check('the recorded implementation digest is the digest of the program that ran', verdict.implementationDigest === programDigest)
    check('the recorded artifact digest is the digest of the bytes on disk', verdict.artifactDigest === sha256(await readFile(artifactPath)))

    await commands.recordVerdict({ commandId: 'verdict-count', taskId: CHILD_COUNT, verdict: { ...verdict, criterionId: 'counted' } })
    await store.emit({ commandId: 'verify-count', protocol: TASK_PROTOCOL, version: TASK_VERSION, kind: 'run/verified', subject: CHILD_COUNT, payload: { runId: 'run-count' } })

    // ---------------------------------------------------------------- 3. swapping the artifact
    const goodArtifact = await readFile(artifactPath)
    await writeFile(artifactPath, '999', 'utf8')
    const afterSwap = await asyncRefusalOf(() =>
      commands.recordVerdict({ commandId: 'verdict-swapped', taskId: CHILD_COUNT, verdict: { ...verdict, criterionId: 'counted' } }),
    )
    check('swapping the artifact after the verdict is refused rather than inherited', afterSwap.code === 'illegal-transition' || afterSwap.code === 'evidence-conflict' || afterSwap.code === 'evidence-input-mismatch', afterSwap.code)
    await writeFile(artifactPath, goodArtifact)

    // ---------------------------------------------------------------- 4. replacing the verifier
    const rebuiltVerdict = await asyncRefusalOf(() =>
      runProductionVerdict({
        runId: 'run-count',
        criterion: criterion('counted', 'the artifact holds the count'),
        // The deployment holds the implementation under its own digest; this one is not it.
        implementations: [{ ...implementation, implementationDigest: 'a'.repeat(64) }],
        inputs: INPUTS,
        workspace,
        artifactPath: ARTIFACT_NAME,
        command: [process.execPath, verifyPath, inputPath, artifactPath],
        runJudge: judge,
      }),
    )
    check('a criterion naming an implementation this deployment does not hold is refused', rebuiltVerdict.code === 'unregistered-verifier', rebuiltVerdict.code)

    // ---------------------------------------------------------------- 5. dependency advances
    const afterCount = treeOf()[0]
    check('verifying the dependency lets the dependent become ready', afterCount.children.find(child => child.taskId === CHILD_LIMITS)?.status === 'ready')
    check('the parent is not complete while a criterion is unaccepted', afterCount.complete === false)
    check('the verified child contributes support while the parent awaits its own verdict', afterCount.criteria.find(entry => entry.criterionId === 'counted')?.supportedBy.includes(CHILD_COUNT) && afterCount.criteria.find(entry => entry.criterionId === 'counted')?.satisfiedBy === null)

    // ---------------------------------------------------------------- 6. the budget really stops
    await commands.startRun({ commandId: 'start-limits', taskId: CHILD_LIMITS, runId: 'run-limits', revision: pin })
    await commands.openBubble({
      commandId: 'bubble-limits',
      taskId: CHILD_LIMITS,
      runId: 'run-limits',
      inputs: INPUTS,
      workspace: { kind: 'dir', ref: workspace },
      model: 'probe-model-1',
      tools: [{ name: 'count', implementationDigest: programDigest, version: '1' }],
      conditions: ['no-network'],
    })
    await commands.failRun({ commandId: 'fail-limits', taskId: CHILD_LIMITS, runId: 'run-limits', reason: 'the limit check could not be run in this environment' })

    const spent = await asyncRefusalOf(() => commands.startRun({ commandId: 'start-limits-again', taskId: CHILD_LIMITS, runId: 'run-limits-2', revision: pin }))
    check('a spent budget stops the sub-task being started again', spent.code === 'illegal-transition' && spent.detail.includes('budget exhausted'), spent.detail)

    const tree = treeOf()[0]
    const stopped = tree.children.find(child => child.taskId === CHILD_LIMITS)
    check('the plan reports the sub-task as stopped, in its own words', stopped?.status === 'stopped' && (stopped.reason ?? '').includes('budget exhausted'), stopped?.reason)
    check('the parent is still incomplete, and the unaccepted criterion is named', tree.complete === false && tree.criteria.find(entry => entry.criterionId === 'bounded')?.satisfiedBy === null)
    check('the stopped sub-task is listed as blocked with a reason', tree.blocked.some(entry => entry.taskId === CHILD_LIMITS))

    // ---------------------------------------------------------------- 7. the receipt
    const held = store.load().entries()
    const countState = foldSubjects(registry, held, TASK_PROTOCOL, TASK_VERSION).get(CHILD_COUNT)
    const receipt = projectReceipt(registry, held, CHILD_COUNT, 'run-count')
    const named = held.slice(0, receipt.cutoff)
    const settlement = held.find(entry => entry.kind === TASK_KINDS.runVerified && entry.subject === CHILD_COUNT)
    check(
      'the receipt stops at its own committed settlement',
      receipt.cutoff === settlement.seq + 1 && named.at(-1).seq === settlement.seq,
      `the receipt names ${receipt.cutoff}, settlement is #${settlement.seq}`,
    )
    check(
      'later facts about the other child stay outside the receipt',
      receipt.cutoff < held.length && held.slice(receipt.cutoff).every(entry => entry.subject === CHILD_LIMITS),
      `receipt ${receipt.cutoff}, current log ${held.length}`,
    )
    // Reading two: re-deriving from exactly the prefix the bound names must give this receipt. A
    // bound that is not the source of the receipt cannot reproduce it, and a projection that refuses
    // to derive from the prefix it claims has named facts its receipt did not come from.
    let rederived = null
    try {
      rederived = projectReceipt(registry, named, CHILD_COUNT, 'run-count')
    } catch (error) {
      if (!(error instanceof ProtocolRefusal)) throw error
    }
    check(
      're-deriving from the prefix the receipt names gives the same receipt',
      rederived !== null && receiptDigest(rederived) === receiptDigest(receipt),
      `the receipt names ${receipt.cutoff} fact(s); re-deriving from those facts gives ${rederived === null ? 'no receipt' : `${receiptDigest(rederived).slice(0, 16)}…`} against ${receiptDigest(receipt).slice(0, 16)}…`,
    )
    // Reading three, the shape a caller chooses instead of the log: the same run's facts with the
    // other subjects' facts taken out. They are real facts, at real sequence numbers, so this array
    // is not a prefix and cannot source a receipt - the one thing the projection must not do is
    // re-bound it silently and hand back a receipt whose bound covers what it does not hold.
    const foreign = held.filter(entry => entry.subject !== CHILD_COUNT)
    check('the log this reader holds has other subjects in it, so filtering it is a real choice', foreign.length > 0, `${held.length} fact(s), all of "${CHILD_COUNT}"`)
    let apart = null
    let apartRefusal = null
    try {
      apart = projectReceipt(registry, held.filter(entry => entry.subject === CHILD_COUNT), CHILD_COUNT, 'run-count')
    } catch (error) {
      if (!(error instanceof ProtocolRefusal)) throw error
      apartRefusal = error.refusal
    }
    check(
      'a subject-filtered array derives no receipt rather than a different bound',
      apart === null && apartRefusal?.code === 'chain-broken' && (apartRefusal.detail ?? '').includes('prefix'),
      apart === null ? `${apartRefusal?.code}: ${apartRefusal?.detail}` : `it derived cutoff ${apart.cutoff} over ${held.filter(entry => entry.subject === CHILD_COUNT).length} fact(s)`,
    )
    // What the attempt consumed, checked against the facts below that bound rather than against what
    // this probe passed in: the verdict fact for the run that was judged, and the bubble fact for the
    // run nothing judged. Both lists below come off the log, and the verdict's is the one the
    // verifier hashed from the bytes it read - which is also why the digest in it is hashed again
    // here, from the file on disk.
    const verdictFact = named.find(
      entry => entry.protocol === TASK_PROTOCOL && entry.version === TASK_VERSION && entry.kind === TASK_KINDS.evidenceProduced && entry.subject === CHILD_COUNT,
    )
    check('the prefix the receipt names holds the verdict fact for the run it accounts for', verdictFact !== undefined)
    check(
      'the verdict below the bound is the one the receipt reports, judged on the inputs it recorded',
      receipt.consumption.basis === 'judged' && JSON.stringify(receipt.consumption.inputs) === JSON.stringify(verdictFact?.payload.inputDigests),
      `the receipt reads ${JSON.stringify(receipt.consumption)}; the verdict below its bound reads ${JSON.stringify(verdictFact?.payload.inputDigests ?? null)}`,
    )
    check(
      'the judged input digest is the digest of the bytes on disk',
      JSON.stringify(receipt.consumption.inputs) === JSON.stringify([{ name: 'words.txt', digest: sha256(await readFile(inputPath)) }]),
      `the receipt reads ${JSON.stringify(receipt.consumption.inputs)}`,
    )
    const declaredBubble = held.find(
      entry => entry.protocol === TASK_PROTOCOL && entry.version === TASK_VERSION && entry.kind === TASK_KINDS.bubbleOpened && entry.subject === CHILD_LIMITS,
    )
    const limitsReceipt = projectReceipt(registry, held, CHILD_LIMITS, 'run-limits')
    check(
      'a run nothing judged reports consumption as declared, and the declaration is the bubble fact',
      limitsReceipt.consumption.basis === 'declared' && JSON.stringify(limitsReceipt.consumption.inputs) === JSON.stringify(declaredBubble?.payload.inputs),
      `the receipt reads ${JSON.stringify(limitsReceipt.consumption)}; the bubble fact reads ${JSON.stringify(declaredBubble?.payload.inputs ?? null)}`,
    )
    // The artifact the receipt pins, read from the verdict fact below its bound rather than from the
    // verdict object this probe computed: a check against the probe's own value would be comparing
    // the receipt to the argument it was built from.
    let loggedArtifact = null
    if (verdictFact !== undefined && typeof verdictFact.payload === 'object' && verdictFact.payload !== null)
      loggedArtifact = verdictFact.payload.artifactDigest
    check(
      'the receipt pins the artifact the verdict fact below its bound records',
      loggedArtifact !== null && receipt.criteria[0]?.artifactDigest === loggedArtifact,
      `the receipt reads ${receipt.criteria[0]?.artifactDigest}; the verdict fact reads ${loggedArtifact}`,
    )
    check('the artifact the verdict fact records is the digest of the bytes on disk', loggedArtifact === sha256(await readFile(artifactPath)), loggedArtifact)
    check(
      'removing an unrelated late fact keeps the same frozen receipt',
      receiptDigest(projectReceipt(registry, held.slice(0, held.length - 1), CHILD_COUNT, 'run-count')) === receiptDigest(receipt),
    )
    // A prefix that stops before the run has no receipt in it, so no bound can claim that source -
    // and neither has one that holds the run but stops before its settlement, which is the bound a
    // reader mid-run actually holds.
    const noneYet = refusalOf(() => projectReceipt(registry, held.slice(0, 1), CHILD_COUNT, 'run-count'))
    check('a prefix holding none of the run has no receipt to derive', noneYet.code === 'unknown-run', noneYet.code)
    const beforeSettling = refusalOf(() => projectReceipt(registry, held.slice(0, settlement?.seq ?? 0), CHILD_COUNT, 'run-count'))
    check(
      'a prefix that stops before the settlement has no receipt to derive',
      beforeSettling.code === 'illegal-transition' && (beforeSettling.detail ?? '').includes('still running'),
      `the prefix stops at ${settlement?.seq ?? 0}: ${beforeSettling.code} ${beforeSettling.detail}`,
    )

    // ---------------------------------------------------------------- 8. the reader
    const view = projectTask(countState)
    check('the child settled verified', view.phase === 'verified')
    check('a reader sees the implementation digest that decided it', view.criteria[0]?.implementationDigest === programDigest)

    console.log('')
    console.log(`  facts ${held.length}; parent complete=${tree.complete}; stopped=${stopped?.status}`)
    console.log(`  receipt ${receiptDigest(receipt).slice(0, 16)}… (${receipt.status}, ${receipt.cutoff} facts, consumption ${receipt.consumption.basis}, derived — never written)`)

    await store.close()
    await live.context.fiber.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

await main()

if (failures.length > 0) {
  console.error(`\nslice-b: ${failures.length} check(s) failed: ${failures.join(' | ')}`)
  process.exitCode = 1
} else {
  console.log('\nslice-b: OK — the root/child slice runs end to end with a real verifier')
}

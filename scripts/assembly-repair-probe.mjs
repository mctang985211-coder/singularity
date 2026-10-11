#!/usr/bin/env node
/**
 * G1 evidence: a run left in flight by a killed process is repaired by the next real boot.
 *
 * **What this probe is for.** `browser-probe.mjs` kills the server *between* turns, which proves the
 * session and the committed facts survive. This one covers the harder window the blueprint's crash
 * table names: the process died after `run/started` and `bubble/opened` were committed and before any
 * verdict was recorded. Nothing can be asserted about that state from inside a live process, so the
 * state is produced here through **core's own commands** — the same ones the assembly drives — and then
 * the real profile is booted, which is what runs the repair.
 *
 * **Why it is not the product's control.** The state is crafted in a control id of its own
 * (`singularity-recovery-probe`) and a workspace of its own, selected by a `--patch` overlay written to
 * a temporary directory. The deployment's log therefore gains no synthetic task, and the thing under
 * test is still the real plugin: the real host row, the real store, the real domain, the real repair.
 *
 * **What it proves, and what it does not.** It proves that a boot finishes an in-flight run: one whose
 * frozen artifact and input are still there is judged again and settled `verified`, one whose artifact
 * is gone is settled `failed` with a named reason, the boot succeeds in both cases, and a second boot
 * appends nothing. It does not prove that a *kill* leaves exactly this state — that is the browser
 * probe's leg — nor that the model answers the same way twice.
 *
 * Usage: node scripts/assembly-repair-probe.mjs
 *   Requires `. /home/ROXY/singularity-next/env.sh` and a deployed profile.
 *
 * @module singularity-core/scripts/assembly-repair-probe
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DSH_HOME, openPersistence } from './dsh-control-runtime.mjs'

// The hook above only resolves modules imported after it runs, so everything that reaches a DSH package
// is imported here rather than in the hoisted static block.
const { createAgentNodeCommands } = await import('../src/agent/commands.ts')
const { AGENT_ROLE, declareAgentProtocol } = await import('../src/agent/protocol.ts')
const { ControlSessionStore } = await import('../src/control/session-store.ts')
const { createEnvironmentCommands } = await import('../src/environment/commands.ts')
const { declareEnvironmentProtocol, ENVIRONMENT_PROTOCOL, ENVIRONMENT_ROLE, ENVIRONMENT_VERSION } = await import('../src/environment/protocol.ts')
const { ProtocolRegistry } = await import('../src/protocol/registry.ts')
const { createTaskCommands } = await import('../src/task/commands.ts')
const { declareTaskProtocol, SCHEDULER_ROLE, TASK_KINDS, TASK_PROTOCOL, TASK_VERSION, verifierRoleOf } = await import('../src/task/protocol.ts')
const { projectReceipt } = await import('../src/task/view.ts')

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = DSH_HOME
const PROFILE = 'singularity-next-web'
const CONTROL = 'singularity-recovery-probe'
const WORKSPACE_ROOT = join(HOME, 'workspaces', CONTROL)
const DOMAIN_DIR = join(CHECKOUT, 'deployment', 'domain', 'letters')
const AGENT = 'agent-probe'
const REPAIRABLE = 'task-probe-repairable'
const GONE = 'task-probe-unrepairable'
const RUN = 'run-probe-1'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
/** The input this probe freezes, and the count the criterion's own rule gives it. */
const INPUT_TEXT = 'The quick brown fox jumps over 13 lazy dogs! 42\n'
const LETTERS = (INPUT_TEXT.match(/[A-Za-z]/g) ?? []).length

let failures = 0
function check(name, condition, detail) {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${name}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures += 1
}

/** The domain, read the way the assembly reads it: the declaration and the bytes beside it. */
async function readDomain() {
  const declaration = JSON.parse(await readFile(join(DOMAIN_DIR, 'task.json'), 'utf8'))
  const verifier = declaration.verifiers[0]
  const digest = sha256(await readFile(join(DOMAIN_DIR, verifier.program)))
  return {
    inputPath: declaration.inputs[0],
    artifact: declaration.workspace.artifact,
    templateDigest: sha256(await readFile(join(DOMAIN_DIR, 'task.json'))),
    verifier: { ref: verifier.ref, version: verifier.version, digest },
    criterion: {
      criterionId: declaration.criteria[0].criterionId,
      statement: declaration.criteria[0].statement,
      verifierRef: verifier.ref,
      verifierVersion: verifier.version,
      implementationDigest: digest,
    },
  }
}

const domain = await readDomain()
const registry = new ProtocolRegistry()
declareTaskProtocol(registry)
declareAgentProtocol(registry)
declareEnvironmentProtocol(registry)
const subjects = {
  [SCHEDULER_ROLE]: `${CONTROL}:scheduler`,
  [AGENT_ROLE]: `${CONTROL}:runtime`,
  [ENVIRONMENT_ROLE]: `${CONTROL}:environment`,
  [verifierRoleOf({ verifierRef: domain.verifier.ref, verifierVersion: domain.verifier.version })]: `${CONTROL}:verifier:${domain.verifier.ref}@${domain.verifier.version}`,
}

async function openStore() {
  // The host's own root, in the host's own encoding: this probe writes where a real boot reads.
  const open = await openPersistence(join(HOME, 'sessions'), 'zstd')
  // The context is kept alive by the returned store's own service handle; dropping it here would be
  // dropping the plugin that owns the persistence this store writes through.
  const store = await ControlSessionStore.open({ persistence: open.persistence, controlId: CONTROL, registry, subjects, cwd: WORKSPACE_ROOT })
  return { store, context: open.context }
}

/** Leave one run in flight, exactly as far as a process that died mid-submit would have got. */
async function craft(store, taskId, withArtifact) {
  const agents = new Map([[AGENT, { as: `agent:${AGENT}` }]])
  // The assembly's own derivation, declared the same way: Web agents are minted at runtime.
  store.declareSubject(`agent:${AGENT}`, `${CONTROL}:agent:${AGENT}`)
  const commands = createTaskCommands({
    store,
    registry,
    agents,
    implementations: [{ ref: domain.verifier.ref, version: domain.verifier.version, implementationDigest: domain.verifier.digest }],
  })
  const agentCommands = createAgentNodeCommands({ store, registry })
  const environment = createEnvironmentCommands({ store, registry })
  const forAgent = commands.forAgent(AGENT)
  const workspace = join(WORKSPACE_ROOT, 'tasks', taskId)
  const inputPath = join(workspace, domain.inputPath)
  await mkdir(dirname(inputPath), { recursive: true })
  await writeFile(inputPath, INPUT_TEXT, 'utf8')
  const input = { name: domain.inputPath, digest: sha256(await readFile(inputPath)) }
  const revisionId = `rev-${sha256(`${domain.templateDigest}\u0000${input.digest}`).slice(0, 16)}`

  await agentCommands.open({ commandId: `agent:${AGENT}`, agentId: AGENT, sessionId: `singularity:agent:${AGENT}`, role: 'root' })
  await forAgent.admit({
    commandId: `admit:${taskId}`,
    taskId,
    contract: { goal: `probe run for ${taskId}`, inputs: [domain.inputPath], criteria: [domain.criterion] },
  })
  await forAgent.assign({ commandId: `assign:${taskId}`, taskId, agentId: AGENT })
  await environment.createRevision({
    commandId: `revision:${revisionId}`,
    environmentId: CONTROL,
    revisionId,
    manifest: { taskTemplate: domain.templateDigest, inputs: [input] },
  })
  const contentDigest = store.load().stateOf(ENVIRONMENT_PROTOCOL, ENVIRONMENT_VERSION, CONTROL).revisions[revisionId].contentDigest
  await forAgent.startRun({ commandId: `start:${taskId}/${RUN}`, taskId, runId: RUN, revision: { environmentId: CONTROL, revisionId, digest: contentDigest } })
  await forAgent.openBubble({
    commandId: `bubble:${taskId}/${RUN}`,
    taskId,
    runId: RUN,
    inputs: [input],
    workspace: { kind: 'dir', ref: workspace },
    model: 'probe:crafted-in-flight',
    tools: [{ name: 'node', version: process.version, implementationDigest: sha256(await readFile(process.execPath)) }],
    conditions: [],
  })
  if (withArtifact) await writeFile(join(workspace, domain.artifact), `${LETTERS}\n`, 'utf8')
}

/** One patch layer over the deployed profile: the probe's own control, domain and workspace. */
async function probePatch() {
  const dir = await mkdtemp(join(tmpdir(), 'repair-probe-'))
  const file = join(dir, 'probe.patch.yml')
  await writeFile(
    file,
    ['- id: singularity-assembly', '  config:', `    controlId: ${CONTROL}`, `    domainDir: ${DOMAIN_DIR}`, `    workspaceRoot: ${WORKSPACE_ROOT}`, ''].join('\n'),
  )
  return { dir, file }
}

const boot = async patch => {
  const result = spawnSync('dsh', ['--profile', PROFILE, '--patch', patch, '--help'], { encoding: 'utf8', env: process.env })
  return { status: result.status, stderr: result.stderr ?? '' }
}

const { store: crafted } = await openStore()
await craft(crafted, REPAIRABLE, true)
await craft(crafted, GONE, false)
await crafted.close()

const { dir, file } = await probePatch()
const first = await boot(file)
check('the real profile boots over the probe overlay', first.status === 0, `dsh exited ${first.status}: ${first.stderr.trim().split('\n').slice(-2).join(' | ')}`)
check('no bundle was skipped', !first.stderr.includes('skipping profile bundle'), first.stderr.trim().split('\n').slice(-2).join(' | '))
check('every row activated', !first.stderr.includes('did not activate'), first.stderr.trim().split('\n').slice(-2).join(' | '))

const { store: repaired } = await openStore()
const cut = repaired.load()
const verifiedRun = cut.stateOf(TASK_PROTOCOL, TASK_VERSION, REPAIRABLE)?.runs[RUN]
const goneRun = cut.stateOf(TASK_PROTOCOL, TASK_VERSION, GONE)?.runs[RUN]
check('the repairable run is settled by the boot', verifiedRun?.status === 'verified', `status is ${verifiedRun?.status ?? 'absent'}`)
check(
  'the repairable run carries a passing verdict from the deployed verifier',
  verifiedRun?.evidence.some(entry => entry.verdict === 'pass' && entry.verifierRef === domain.verifier.ref),
  JSON.stringify(verifiedRun?.evidence ?? null),
)
check('the unrepairable run is settled failed by a name', goneRun?.status === 'failed' && (goneRun.failureReason ?? '').length > 0, JSON.stringify(goneRun ?? null))
check('the failure names the run whose artifact is gone', (goneRun?.failureReason ?? '').includes(RUN), goneRun?.failureReason)
check('the receipt projects over the repaired run', (() => { try { return projectReceipt(registry, cut.entries(), REPAIRABLE, RUN).cutoff > 0 } catch { return false } })())
const terminal = cut.entriesOf(TASK_PROTOCOL, TASK_VERSION).filter(entry => entry.subject === REPAIRABLE || entry.subject === GONE).filter(entry => entry.kind === TASK_KINDS.runVerified || entry.kind === TASK_KINDS.runFailed)
check('each in-flight run gained exactly one terminal fact', terminal.length === 2, `${terminal.length} terminal fact(s)`)
const settledCount = cut.entries().length
await repaired.close()

const second = await boot(file)
const { store: after } = await openStore()
check('a second boot is idempotent', second.status === 0 && after.load().entries().length === settledCount, `${settledCount} → ${after.load().entries().length} entries`)
check('the verified settlement is the same fact', after.load().stateOf(TASK_PROTOCOL, TASK_VERSION, REPAIRABLE)?.runs[RUN]?.status === 'verified')
await after.close()

for (const entry of await readdir(join(HOME, 'sessions'))) if (entry.includes(CONTROL)) await rm(join(HOME, 'sessions', entry), { recursive: true, force: true })
await rm(dir, { recursive: true, force: true })
await rm(WORKSPACE_ROOT, { recursive: true, force: true })

console.log(failures === 0 ? 'assembly-repair-probe: OK' : `assembly-repair-probe: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1

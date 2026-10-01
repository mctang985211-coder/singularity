/**
 * K3 end to end on the real deployment wiring: the unit a skill improvement
 * moves is the skill's whole loadable object — `SKILL.md`, plus the
 * `SKILL.contract.json` beside it when the object declares an execution provider
 * — and every write of that object is the one K2 commit path, extended to the
 * object's fixed file set.
 *
 * What is real: the real filesystem (the ledger file, the sandbox, the production
 * `SKILL.md` and `SKILL.contract.json`), the real `EvolutionService` with its
 * fold, derive-and-compare promotion checks, commit path and reconciliation, the
 * real `TaskRuntime` entries (intake, `decomposeAndRun`, `replayTask`, `adoptRoot`
 * and its recovery barrier), the real admission pre-check over the real discovery
 * roots, the real `AgentRuntime.spawn` over the real skill plane, the real
 * `VerifierRegistry` with its built-in `command` judge, the real `TaskService`
 * store and run bindings, and all nine evolution tools where a case is about the
 * tool layer. Only the model loop is scripted — and it is scripted in the one way
 * that makes the experiment evidence real: the worker reads the `SKILL.md` its own
 * skill layer resolved and executes the `WRITE:<file>` instructions in it, so
 * which side produced which answer file is the deployment's own resolution of the
 * grant, not a fixture flag.
 *
 * What each group pins, and where its answer is read from:
 *
 * - K3-1 — the main chain: an existing execution skill whose old body fails a
 *   frozen acceptance criterion and whose new body fixes it, evaluated by the
 *   real two-sided experiment, promoted by two real human gates, applied as one
 *   two-file commit. The assertions are read off the run bindings' own snapshots
 *   (both files, byte for byte), the production files, and the derived sidecar
 *   compared field by field with the one production held.
 * - K3-2 — the refusals that happen *before* anything is written: a knowledge
 *   sidecar, declared resources, a tampered sidecar field, a bad content digest,
 *   a renamed candidate, a judge that moved and a grant that narrowed. Each is
 *   asked of the real entry, and production and the ledger are read back to prove
 *   they did not move.
 * - K3-3 — drift after the freeze: a file changed between prepare and the
 *   experiment, or between the decision and the write, refuses by name; the two
 *   sides' workspaces stay complete and isolated.
 * - K3-4 — the two-file commit's recovery: every durable window is interrupted
 *   (in-process for the four seams, and by SIGKILL in a nested process image for
 *   four of them), then the same directory is reopened by a second process image
 *   and reconciled. A mixed pair — the new `SKILL.md` beside the old sidecar — is
 *   never admissible, and the recovery always lands on one complete version.
 * - K3-5 — the current ledger format read back after a reopen, the applied
 *   two-file object rolled back whole, and the nine tools driven end to end on an
 *   execution object.
 *
 * **The two kinds of interruption are different things, and this spec keeps them
 * apart**, exactly as `k2-evolution-commit.spec.ts` does: {@link windowProbe} is
 * the in-process seam (a catchable throw, whose `catch`/`finally` run), and
 * {@link spawnCommitChild} starts a nested run of this very spec that answers its
 * armed window with `process.kill(process.pid, 'SIGKILL')` — no `catch`, no
 * `finally`, no cleanup, and a parent that observes the signal and a dead pid.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { AcceptanceCriterion, RunProviderBinding } from '../../task/src/index.ts'
import { SKILL_SIDECAR_FILE, serializeSkillSidecar, skillContentDigest, skillContractDigest } from '../../task-runtime/src/index.ts'
import type { CapabilityConfig, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import type { VerificationResult, Verifier, VerifyRequest } from '../../verifier/src/index.ts'
import { EvolutionService, buildExperimentReport } from '../../evolution/src/index.ts'
import type { CommitDirection, ExperimentReport, SkillContentIdentity } from '../../evolution/src/index.ts'
import type { CommitStage } from '../../evolution/src/commit.ts'
import { deploymentModelSelection } from '../../agent-singularity/src/index.ts'
import { defineEvolutionApplyTool } from '../../agent-singularity/src/tools/evolution-apply.ts'
import { defineEvolutionCandidateTool } from '../../agent-singularity/src/tools/evolution-candidate.ts'
import { defineEvolutionDecideTool } from '../../agent-singularity/src/tools/evolution-decide.ts'
import { defineEvolutionGateTool } from '../../agent-singularity/src/tools/evolution-gate.ts'
import { defineEvolutionListTool } from '../../agent-singularity/src/tools/evolution-list.ts'
import { defineEvolutionPrepareTool } from '../../agent-singularity/src/tools/evolution-prepare.ts'
import { defineEvolutionProposeTool } from '../../agent-singularity/src/tools/evolution-propose.ts'
import { defineEvolutionReplayTool } from '../../agent-singularity/src/tools/evolution-replay.ts'
import { defineEvolutionRollbackTool } from '../../agent-singularity/src/tools/evolution-rollback.ts'
import {
  disposeRunStacks,
  replaySessionLogs,
  sha256Of,
  startRunStack,
  type RunStack,
} from '../support/run-stack.ts'

/** The capability row every case grants its skills through — one row, so the frozen provider list resolves the improved skill. */
const ROW = 'k3-unit-row'
/** A second skill, used where a case must show one target is not another's. */
const CLEAN_SKILL = 'k3-clean-fixture-skill'
/** Fixture names no deployment installs, so the machine running the suite cannot decide a verdict here. */
const SKILL = 'k3-unit-fixture-skill'
const ROOT_A = 's-k3-root-a' as SessionId
const ROOT_B = 's-k3-root-b' as SessionId
const ROOT_C = 's-k3-root-c' as SessionId
const P1 = 'k3-p1'
const P2 = 'k3-p2'
/** The version the fixture installs in production, and the one a candidate replaces it with. */
const V0 = 'K3 VERSION ZERO BODY'
const V1 = 'K3 VERSION ONE BODY'
/** The version a third party writes while a commit intent is open. */
const THIRD_PARTY = 'K3 A VERSION NO COMMIT OF THIS LEDGER WROTE'

/** The answer files this spec's skill bodies name, and the criteria that judge them. */
const ANSWER_FILES = ['fix.txt', 'keep.txt', 'holdout.txt', 'tail.txt'] as const

/** The file the scripted worker records the digest of the `SKILL.md` it actually loaded in. */
const MARKER = 'k3-loaded-skill.sha256'

/**
 * The env a nested child is started with: the durable window it dies at, the
 * direction it commits in, which file of the object it dies before, and the
 * workspace both processes share. A run that sets none is a parent — the child
 * case below is skipped and nothing here kills anything; a run whose parent set
 * them *is* the child.
 */
const EXIT_WINDOW = process.env.K3_REAL_EXIT_WINDOW as CommitStage | undefined
const EXIT_DIRECTION = (process.env.K3_REAL_EXIT_DIRECTION ?? 'apply') as CommitDirection
const EXIT_FILE = (process.env.K3_REAL_EXIT_FILE ?? 'skill') as 'skill' | 'sidecar'
const EXIT_WORKSPACE = process.env.K3_REAL_EXIT_WORKSPACE

/** The file a child writes its own pid into, before its commit — the parent's proof of which process image died. */
const EXIT_MARKER = 'k3-child-exit.json'
/** The file the boot's own session logs travel in when a nested child has to re-read them. */
const SESSION_HANDOVER = 'k3-child-sessions.json'
/** The one case a nested run is filtered to; no other case of this spec runs there. */
const CHILD_CASE = 'the child process dies by SIGKILL at its armed window'

/** The repo root a nested run starts from, and this spec's own file — the one file a nested run collects. */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const SPEC_PATH = fileURLToPath(import.meta.url)

/** The second capability row: it grants the guidance skill the K3-2 positive case promotes. */
const GUIDE_ROW = 'k3-guide-row'

/** The capability table both boots of a case admit against: one row per shape of object this spec improves. */
const TABLE: Readonly<Record<string, CapabilityConfig>> = {
  [ROW]: { skills: [SKILL], tools: ['filesystem', 'bash'] },
  [GUIDE_ROW]: { skills: [CLEAN_SKILL], tools: ['filesystem'] },
}

/** The workspaces this spec minted: a caller-supplied workspace is the spec's to remove, not a stack's. */
const workspaces: string[] = []

afterEach(async () => {
  await disposeRunStacks()
  for (const directory of workspaces.splice(0)) await rm(directory, { recursive: true, force: true })
})

/* ------------------------------------------------------------------------- *
 * The stack
 * ------------------------------------------------------------------------- */

/** One boot: the stack, the evolution plane over the shared ledger and skill roots, and the tools on the root's surface. */
interface UnitStack {
  readonly h: RunStack
  readonly svc: EvolutionService
  /** Every tool name this stack's own dispatcher was asked for, in order — the record of which entries ran. */
  readonly called: string[]
  /** One evolution tool call as the loop dispatches it: the answer's own text, and its error flag. */
  call(name: string, args: Record<string, unknown>, sessionId?: SessionId): Promise<{ text: string; isError: boolean }>
}

/**
 * Boot one stack, or reopen one over a directory a previous boot used. The
 * evolution plane is constructed here — one instance per boot, before anything
 * asks the runtime to admit — because the runtime's commit gate reads the ledger
 * through the service this context holds.
 */
async function boot(options: {
  workspace?: string
  roots?: readonly SessionId[]
  capabilities?: Readonly<Record<string, CapabilityConfig>>
  /** Register the nine evolution tools on every root's own scope. */
  tools?: boolean
  /** Keep the scripted worker off (a case that never runs a worker). */
  quiet?: boolean
  commitProbe?: (stage: CommitStage, target?: string) => void
} = {}): Promise<UnitStack> {
  const roots = options.roots ?? [ROOT_A, ROOT_B, ROOT_C]
  let h!: RunStack
  h = await startRunStack({
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    roots: [...roots],
    capabilities: { ...(options.capabilities ?? TABLE) },
    tools: true,
    evolution: true,
    ...(options.quiet === true ? {} : { worker: (sessionId: SessionId, agent: Agent) => unitWorker(h, sessionId, agent) }),
  })
  const svc = new EvolutionService(h.ctx, {
    root: ledgerRoot(h),
    skillRoot: join(h.home, 'skills'),
    // The deployment's own selection: the experiment freezes it and the promotion
    // gate re-reads the runs' own requests against it.
    modelSelection: () => deploymentModelSelection(h.ctx),
    ...(options.commitProbe === undefined ? {} : { commitProbe: options.commitProbe }),
  })
  if (options.tools !== false) {
    for (const root of roots) {
      const scope = h.rootAgent(root).ctx
      for (const tool of [
        defineEvolutionProposeTool(h.ctx),
        defineEvolutionCandidateTool(h.ctx),
        defineEvolutionPrepareTool(h.ctx),
        defineEvolutionReplayTool(h.ctx),
        defineEvolutionGateTool(h.ctx),
        defineEvolutionDecideTool(h.ctx),
        defineEvolutionApplyTool(h.ctx),
        defineEvolutionRollbackTool(h.ctx),
        defineEvolutionListTool(h.ctx),
      ]) {
        scope.tools.register(tool)
      }
    }
  }
  const called: string[] = []
  return {
    h,
    svc,
    called,
    async call(name, args, sessionId = ROOT_A) {
      const result = await h.call(h.rootAgent(sessionId), name, args)
      called.push(name)
      return { text: result.text, isError: result.isError }
    },
  }
}

/** One directory two boots share — the "same directory" a reopened process reads its ledger and production from. */
async function sharedDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'k3-unit-'))
  workspaces.push(directory)
  return directory
}

/* ------------------------------------------------------------------------- *
 * The skill object on disk
 * ------------------------------------------------------------------------- */

/** What one installed skill object is: the skill root, both files' bytes, and the content identity they add up to. */
interface InstalledSkill {
  readonly directory: string
  readonly skillMd: string
  readonly skillMdSha256: string
  /** The `SKILL.contract.json` bytes, absent for a guidance object. */
  readonly sidecar?: string
  /** The identity `prepare` will record for this object (P3): the name, the `SKILL.md` digest, and the sidecar's two digests. */
  readonly identity: SkillContentIdentity
}

/**
 * The steps one skill body carries. The vocabulary is the fixture's own
 * (`WRITE:<file>` / `SKIP:<file>`) and the scripted worker executes it literally,
 * so which files a side produced is read off the body that side loaded.
 */
function skillBody(name: string, writes: readonly string[], description = `${name} fixture skill`): string {
  const body = ANSWER_FILES.map(file => (writes.includes(file) ? `WRITE:${file}` : `SKIP:${file}`)).join('\n')
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

/**
 * Install one skill object under `root` — `SKILL.md` always, plus a declaration
 * beside it when the object has one. The declaration is written through
 * {@link serializeSkillSidecar}, i.e. in the canonical bytes this build's own
 * writer produces, so a later "only one field moved" comparison is a byte-level
 * statement and not an artefact of key order.
 */
async function writeSkillObject(root: string, input: {
  name?: string
  body: string
  /** `execution`, `knowledge`, or absent for a guidance object. */
  sidecar?: 'execution' | 'knowledge'
  /** The digest the declaration claims for the `SKILL.md` (defaults to the real one — a wrong value is a case of its own). */
  declaredSkillMdSha256?: string
  /** Files under supported resource positions, and the digest each is declared with (defaults to the real one). */
  resources?: readonly { path: string; bytes: string; declaredSha256?: string }[]
  verifierRef?: string
  requiredTools?: readonly string[]
}): Promise<InstalledSkill> {
  const name = input.name ?? SKILL
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'SKILL.md'), input.body, 'utf8')
  const resources = [...(input.resources ?? [])].sort((left, right) => (left.path < right.path ? -1 : 1))
  for (const resource of resources) {
    const at = join(directory, resource.path)
    await mkdir(join(at, '..'), { recursive: true })
    await writeFile(at, resource.bytes, 'utf8')
  }
  const skillMdSha256 = sha256Of(input.body)
  const declared = input.sidecar === undefined
    ? undefined
    : input.sidecar === 'execution'
      ? {
          contractVersion: 1,
          type: 'execution',
          capabilities: [ROW],
          precondition: 'the fixture skill is installed where discovery looks',
          inputs: [],
          outputs: [],
          requiredTools: [...(input.requiredTools ?? [])],
          verifier: { ref: input.verifierRef ?? 'command' },
          content: {
            skillMdSha256: input.declaredSkillMdSha256 ?? skillMdSha256,
            resources: resources.map(resource => ({ path: resource.path, sha256: resource.declaredSha256 ?? sha256Of(resource.bytes) })),
          },
        }
      : {
          contractVersion: 1,
          type: 'knowledge',
          source: 'this test fixture',
          scope: 'K3 unit fixture',
          content: {
            skillMdSha256: input.declaredSkillMdSha256 ?? skillMdSha256,
            resources: resources.map(resource => ({ path: resource.path, sha256: resource.declaredSha256 ?? sha256Of(resource.bytes) })),
          },
          contentCheck: { kind: 'command', command: 'true' },
        }
  const sidecar = declared === undefined ? undefined : serializeSkillSidecar(declared as never)
  if (sidecar !== undefined) await writeFile(join(directory, SKILL_SIDECAR_FILE), sidecar, 'utf8')
  return {
    directory,
    skillMd: input.body,
    skillMdSha256,
    ...(sidecar === undefined ? {} : { sidecar }),
    identity: {
      name,
      sha256: skillMdSha256,
      ...(sidecar === undefined
        ? {}
        : { contract: { sha256: sha256Of(sidecar), contractDigest: skillContractDigest(declared as never) } }),
    },
  }
}

/* ------------------------------------------------------------------------- *
 * The scripted worker
 * ------------------------------------------------------------------------- */

/**
 * The `SKILL.md` file one worker's own skill layer resolved, read from the path
 * that layer reports. A worker bound to content reads what its grant's roots
 * resolve (the candidate overlay first, then its own snapshot), so this is the
 * file a live worker would have read — not a fixture flag about which side it is.
 * The file is read rather than the layer's body text, because the digest of these
 * bytes is what a run binding's record has to agree with.
 */
async function loadedSkillFile(h: RunStack, agent: Agent, name = SKILL): Promise<string> {
  const skill = await h.ctx.skills.get(name, { scope: agent, cwd: h.checkout })
  if (skill === undefined) throw new Error(`the worker's skill layer holds no "${name}"`)
  const path = (skill as { path?: string }).path
  if (path === undefined) throw new Error(`the worker's skill layer resolved no file for "${name}"`)
  return readFile(path, 'utf8')
}

/**
 * The scripted worker: it reads the skill bytes it loaded, records their digest
 * in its own workspace, and does what the body says — writing each answer file it
 * was told to write. The criteria the runs are judged by are `test -f <file>`
 * commands run in the same directory, so "the old body fails and the new body
 * passes" is the deployment's own judgement of the skill's real effect.
 */
async function unitWorker(h: RunStack, sessionId: SessionId, agent: Agent): Promise<void> {
  const cwd = agent.session.header.cwd
  // Whichever of this spec's fixture skills the run's own grant resolved: the
  // worker reads the file its layer hands it and nothing else.
  let body: string | undefined
  for (const name of [SKILL, CLEAN_SKILL]) {
    try {
      body = await loadedSkillFile(h, agent, name)
      break
    } catch {
      body = undefined
    }
  }
  if (body === undefined) return
  await mkdir(cwd, { recursive: true })
  await writeFile(join(cwd, MARKER), `${sha256Of(body)}\n`, 'utf8')
  for (const file of ANSWER_FILES) {
    if (!body.includes(`WRITE:${file}`)) continue
    await writeFile(join(cwd, file), `${file}\n`, 'utf8')
  }
}

/* ------------------------------------------------------------------------- *
 * Durable surfaces
 * ------------------------------------------------------------------------- */

/** The evolution ledger's directory inside one workspace (both boots resolve the same path). */
function ledgerRoot(h: RunStack): string {
  return join(h.workspace, 'evolution')
}

/** One skill's production `SKILL.md`, and the declaration beside it when the object has one. */
function productionSkill(h: RunStack, name: string = SKILL): string {
  return join(h.home, 'skills', name, 'SKILL.md')
}

function productionSidecar(h: RunStack, name: string = SKILL): string {
  return join(h.home, 'skills', name, SKILL_SIDECAR_FILE)
}

function productionDirectory(h: RunStack, name: string = SKILL): string {
  return join(h.home, 'skills', name)
}

/** The ledger's own lines, read from the file — never from a service's memory. */
async function ledgerLines(h: RunStack): Promise<Record<string, unknown>[]> {
  const file = join(ledgerRoot(h), 'proposals.jsonl')
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
}

/** The ledger file exactly as it stands, for the "this wrote nothing" assertions. */
async function ledgerBytes(h: RunStack): Promise<string> {
  return readFile(join(ledgerRoot(h), 'proposals.jsonl'), 'utf8')
}

function kindsOf(lines: readonly Record<string, unknown>[]): string[] {
  return lines.map(line => String(line.kind))
}

/** One file of a commit intent's own line: the target, both digests, and the recoverable source. */
interface IntentFile {
  readonly target: string
  readonly baselineSha256: string
  readonly contentSha256: string
  readonly source: string
}

function intentFiles(intent: Record<string, unknown>): IntentFile[] {
  const files = intent.files as IntentFile[] | undefined
  if (files === undefined) throw new Error(`the intent line names no files: ${JSON.stringify(intent)}`)
  return files
}

/** Every staging file left beside one production target (a settled commit removes its own, always). */
async function stagingFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter(entry => entry.includes('.tmp-'))
}

/** The two production paths a two-file commit writes, in commit order. */
function commitTargets(h: RunStack, name: string = SKILL): [string, string] {
  return [productionSkill(h, name), productionSidecar(h, name)]
}

/* ------------------------------------------------------------------------- *
 * Runs, admission and bindings
 * ------------------------------------------------------------------------- */

/**
 * The root contract one session's tree is activated with. The capabilities are
 * declared where the case is about the root's own pre-check; the criterion is the
 * one every case here uses.
 */
function rootContract(objective: string, capabilities: readonly string[] = []): RootContractSpec {
  return {
    objective,
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
    ...(capabilities.length === 0 ? {} : { requiredCapabilities: [...capabilities] }),
  }
}

function child(objective: string, requiredCapabilities: readonly string[]): DecomposeSpec['children'][number] {
  return {
    objective,
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
    requiredCapabilities: requiredCapabilities as string[],
  }
}

/** One admitted child run and the worker session it was given. */
async function admitChild(
  h: RunStack,
  sessionId: SessionId,
  root: { storeId: string; taskId: string; runId: string },
  capability = ROW,
): Promise<{ childRunId: string; storeId: string; workerSessionId: SessionId }> {
  const batch = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, sessionId, {
    reason: 'split the work',
    children: [child(`use the ${capability} skill`, [capability])],
  })
  const outcomes = await h.runtime.awaitBatch(root.storeId, batch.batchId)
  expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  const childRunId = outcomes[0]!.runId!
  return { childRunId, storeId: root.storeId, workerSessionId: (await h.task.runIn(root.storeId, childRunId)).sessionId as SessionId }
}

/** The refusal a batch was supposed to produce; an admitted batch is this helper's own failure. */
async function refusalOf(
  h: RunStack,
  sessionId: SessionId,
  root: { storeId: string; taskId: string; runId: string },
  capability = ROW,
): Promise<string> {
  try {
    await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, sessionId, {
      reason: 'split the work',
      children: [child(`use the ${capability} skill`, [capability])],
    })
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('the runtime admitted a batch it was supposed to refuse')
}

/** One run's own binding, read from the store. */
async function bindingOf(h: RunStack, storeId: string, runId: string): Promise<RunProviderBinding> {
  const binding = (await h.task.runIn(storeId, runId)).providerBinding
  if (binding === undefined) throw new Error(`run "${runId}" carries no provider binding`)
  if (binding.snapshotRoot === undefined) throw new Error(`run "${runId}" materialized no snapshot root`)
  return binding
}

/** One skill's two files as a run's own binding snapshot holds them — what that run really loaded. */
async function boundObject(binding: RunProviderBinding, name: string = SKILL): Promise<{ skillMd: string; sidecar?: string }> {
  const root = binding.snapshotRoot!
  const skillMd = await readFile(join(root, name, 'SKILL.md'), 'utf8')
  const sidecarPath = join(root, name, SKILL_SIDECAR_FILE)
  return { skillMd, ...(existsSync(sidecarPath) ? { sidecar: await readFile(sidecarPath, 'utf8') } : {}) }
}

/** The `SKILL.md` file one worker's own layer resolves for `name`, read back off disk. */
async function workerSkillFile(h: RunStack, sessionId: SessionId, name = SKILL): Promise<string> {
  const agent = h.agent(sessionId)
  if (agent === undefined) throw new Error(`the stack holds no live agent for "${String(sessionId)}"`)
  return loadedSkillFile(h, agent, name)
}

/** The stack's own human seam: every `approval.request` the tools made, in order. */
function approvalCalls(h: RunStack): { toolName: string; reason: string }[] {
  const approval = (h.ctx as unknown as {
    get(name: string): { request: { mock: { calls: [{ toolName: string; reason: string }][] } } }
  }).get('approval')
  return approval.request.mock.calls.map(call => call[0])
}

/**
 * The cordis logger's own warnings, as a deployment's log would show them — the
 * surface the host's recovery barrier reports a commit it could not settle on.
 */
function captureWarnings(h: RunStack): string[] {
  const warnings: string[] = []
  const logger = h.ctx.logger as unknown as { exporter(sink: unknown): unknown }
  logger.exporter({
    levels: { default: 3 },
    export: (message: { type: string; args: unknown[] }) => {
      if (message.type === 'warn') warnings.push(String(message.args[0]))
    },
  })
  return warnings
}

/* ------------------------------------------------------------------------- *
 * The historical samples
 * ------------------------------------------------------------------------- */

/** One command-settled criterion, pinned to the registered judge the experiment freezes with. */
function criterion(criterionId: string, command: string, verifierRef = 'command'): AcceptanceCriterion {
  return {
    criterionId,
    description: 'it holds',
    verificationMode: 'deterministic',
    requiredEvidence: [],
    mandatory: true,
    command,
    verifierRef,
  }
}

/**
 * Write one terminal sample straight into the store through the store's own
 * service — the historical record a sample locates its case by. The task asks for
 * the row that grants the skill the experiment improves, because the frozen
 * provider list is read over the rows a sample requires.
 */
async function writeSample(h: RunStack, storeId: string, input: {
  taskId: string
  runId: string
  objective: string
  acceptance: AcceptanceCriterion
  outcome: 'verified' | 'failed'
  capability?: string
}): Promise<void> {
  const capability = input.capability ?? ROW
  await h.task.createTaskIn(storeId, {
    taskId: input.taskId,
    definitionRef: { taskType: 'root', version: 1 },
    objective: input.objective,
    depth: 0,
    acceptanceCriteria: [input.acceptance],
    requestedCapabilities: [capability],
    decompositionStatus: 'leaf',
    status: 'created',
    runIds: [],
    childTaskIds: [],
  }, 'tester')
  await h.task.admitTaskIn(storeId, input.taskId, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(storeId, {
    runId: input.runId,
    taskId: input.taskId,
    sessionId: `s-${input.taskId}`,
    capabilitySnapshot: [SKILL, CLEAN_SKILL],
    artifacts: [],
    verifierResults: [],
    status: 'running',
    startedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, input.taskId, input.runId, 'verifying', 'tester')
  await h.task.recordEvidenceIn(storeId, {
    evidenceId: `e-${input.runId}`,
    taskRunId: input.runId,
    taskId: input.taskId,
    artifacts: [],
    verifierResults: [{ criterionId: input.acceptance.criterionId, status: input.outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command' }],
    claims: [],
    generatedAt: new Date().toISOString(),
  }, 'tester')
  await h.task.markRunStatusIn(storeId, input.taskId, input.runId, input.outcome, 'tester', {
    ...(input.outcome === 'failed' ? { reason: 'the answer file was never produced' } : {}),
  })
  await h.task.recordReviewIn(storeId, {
    taskId: input.taskId,
    runId: input.runId,
    sessionId: `s-${input.taskId}`,
    outcome: input.outcome,
    evidenceRefs: [`e-${input.runId}`],
    anomalies: [`the historical run sample "${input.taskId}" locates`],
    ...(input.outcome === 'failed' ? { localizedCause: 'the answer file was never produced' } : {}),
    criteria: [{ criterionId: input.acceptance.criterionId, verdict: input.outcome === 'verified' ? 'pass' : 'fail', verifierId: 'command' }],
  }, 'tester')
}

/**
 * The historical samples every case of this spec evaluates against: two observed
 * failures a candidate may be asked to fix (`t-fix`, which the body this spec
 * installs first never answers, and `t-tail`, which a *later* version of the same
 * skill still does not answer), a verified regression it must keep, and a
 * held-out case. All of them ask for the row that grants the skill under
 * improvement.
 */
async function writeHistory(h: RunStack, storeId: string, capability = ROW, verifierRef = 'command'): Promise<void> {
  await writeSample(h, storeId, { taskId: 't-fix', runId: 'r-fix-history', objective: 'the answer file is produced', acceptance: criterion('ac-fix', 'test -f fix.txt', verifierRef), outcome: 'failed', capability })
  await writeSample(h, storeId, { taskId: 't-keep', runId: 'r-keep-history', objective: 'the kept answer file is produced', acceptance: criterion('ac-keep', 'test -f keep.txt', verifierRef), outcome: 'verified', capability })
  await writeSample(h, storeId, { taskId: 't-holdout', runId: 'r-holdout-history', objective: 'the held-out answer file is produced', acceptance: criterion('ac-holdout', 'test -f holdout.txt', verifierRef), outcome: 'verified', capability })
  await writeSample(h, storeId, { taskId: 't-tail', runId: 'r-tail-history', objective: 'the trailing answer file is produced', acceptance: criterion('ac-tail', 'test -f tail.txt', verifierRef), outcome: 'failed', capability })
}

const SAMPLES = ['t-fix', 't-keep'] as const
const HOLDOUT = ['t-holdout'] as const

/* ------------------------------------------------------------------------- *
 * The real tool chain
 * ------------------------------------------------------------------------- */

function gateAnswers(refs: readonly string[]) {
  return {
    targetFailureFixed: 'the target failure is fixed on the candidate side',
    originalAcceptanceMaintained: 'the acceptance identity is unchanged',
    existingRegressionMaintained: 'the observed regression and the holdout are maintained',
    noUnacceptableSideEffects: 'the skill object keeps its role, its judge and its tools',
    holdoutPerformanceAcceptable: 'no holdout degraded',
    resourceCostAcceptable: 'recorded from the runs',
    regressionEvidenceRefs: [...refs],
  }
}

/**
 * Walk one skill candidate from `proposed` to `gated` through the real tools, over
 * a completed two-sided experiment on the real runtime: propose → candidate →
 * prepare → replay → gate. Every step is dispatched the way the loop dispatches a
 * call, so what runs is the wiring the model reaches. The experiment's own report
 * path is read back from the ledger's records, never from the answer text.
 */
async function walkToGated(s: UnitStack, input: {
  proposalId: string
  name?: string
  content: string
  actor?: SessionId
  samples?: readonly string[]
  holdout?: readonly string[]
}): Promise<{ reportPath: string; experimentId: string; report: ExperimentReport }> {
  const name = input.name ?? SKILL
  const actor = input.actor ?? ROOT_A
  const steps: [string, Record<string, unknown>][] = [
    ['evolution_propose', {
      proposalId: input.proposalId,
      level: 'L2',
      baseVersion: 'v1',
      targetType: 'skill',
      targetId: name,
      rationale: 'the fixture skill should carry the newer wording',
      sourceRefs: ['diagnosis:k3'],
    }],
    ['evolution_candidate', { proposalId: input.proposalId, versionSet: { skill: 'v2' }, mutationJson: JSON.stringify({ name, content: input.content }) }],
    ['evolution_prepare', { proposalId: input.proposalId }],
    ['evolution_replay', {
      proposalId: input.proposalId,
      taskIds: [...(input.samples ?? SAMPLES)],
      holdoutTaskIds: [...(input.holdout ?? HOLDOUT)],
      budget: { note: 'the fixture declares no cost ceiling' },
    }],
  ]
  for (const [tool, args] of steps) {
    const answer = await s.call(tool, args, actor)
    expect(answer.isError, `${tool}: ${answer.text}`).toBe(false)
    // Every evolution tool answers a refusal as text, so "not an error" is not the
    // same fact as "the call succeeded": a step that refused would otherwise walk
    // past the experiment and fail later for the wrong reason.
    expect(answer.text, `${tool} refused a step this walk needs`).not.toContain('rejected:')
  }
  const [experiment] = await s.svc.experiments(input.proposalId)
  if (experiment === undefined) throw new Error(`proposal "${input.proposalId}" recorded no experiment`)
  const report = buildExperimentReport(await s.svc.experiment(experiment.experimentId))
  const gated = await s.call('evolution_gate', { proposalId: input.proposalId, ...gateAnswers([experiment.report]) }, actor)
  expect(gated.isError, gated.text).toBe(false)
  return { reportPath: experiment.report, experimentId: experiment.experimentId, report }
}

/** Close the human decision through the real tool: one real `approval.request`, then the `decided` line. */
async function decideThroughTool(s: UnitStack, proposalId: string, actor: SessionId = ROOT_A): Promise<string> {
  const answer = await s.call('evolution_decide', { proposalId, decision: 'PROMOTE', note: 'the fix holds' }, actor)
  expect(answer.isError, answer.text).toBe(false)
  expect(answer.text).toContain('[decided] PROMOTE')
  expect(answer.text).toContain('nothing applied yet')
  return answer.text
}

/** Apply through the real tool: the second human gate, the two-file commit, and the applied record. */
async function applyThroughTool(s: UnitStack, proposalId: string, actor: SessionId = ROOT_A): Promise<string> {
  const answer = await s.call('evolution_apply', { proposalId }, actor)
  expect(answer.isError, answer.text).toBe(false)
  expect(answer.text).toContain('[applied]')
  return answer.text
}

/** The report one experiment names, read back from disk. */
async function reportOnDisk(h: RunStack, reportPath: string): Promise<ExperimentReport> {
  return JSON.parse(await readFile(join(ledgerRoot(h), reportPath), 'utf8')) as ExperimentReport
}

/** One sample's side detail in a report. */
function side(report: ExperimentReport, taskId: string, which: 'baseline' | 'candidate') {
  const sample = report.samples.find(item => item.taskId === taskId)
  if (sample === undefined) throw new Error(`the report holds no sample ${taskId}`)
  return sample[which]
}

/**
 * The sidecar one candidate object's declaration should be: the production
 * object's own declaration with exactly `content.skillMdSha256` rewritten to the
 * candidate `SKILL.md` digest. Nothing else may move — not a capability, not a
 * required tool, not the verifier, not a resource.
 */
function derivedSidecar(production: unknown, candidateSkillMdSha256: string): Record<string, unknown> {
  const declaration = structuredClone(production) as Record<string, unknown>
  declaration.content = { ...(declaration.content as Record<string, unknown>), skillMdSha256: candidateSkillMdSha256 }
  return declaration
}

/** The two production files as they stand, as a comparable pair. */
async function productionObject(h: RunStack, name: string = SKILL): Promise<{ skillMd: string; sidecar?: string }> {
  const skillMd = await readFile(productionSkill(h, name), 'utf8')
  const sidecarPath = productionSidecar(h, name)
  return { skillMd, ...(existsSync(sidecarPath) ? { sidecar: await readFile(sidecarPath, 'utf8') } : {}) }
}

/**
 * The digest of a two-file production object, compared the way the intent records
 * it: the `SKILL.md` bytes on their own, and the declaration's canonical digest.
 */
function objectIdentity(name: string, object: { skillMd: string; sidecar?: string }): SkillContentIdentity {
  return {
    name,
    sha256: sha256Of(object.skillMd),
    ...(object.sidecar === undefined
      ? {}
      : { contract: { sha256: sha256Of(object.sidecar), contractDigest: skillContractDigest(JSON.parse(object.sidecar) as never) } }),
  }
}

/** The directory digest of one side's workspace, computed here so the frozen value is never confirmed against itself. */
async function independentDigest(directory: string): Promise<string> {
  const lines: string[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) await walk(join(current, entry.name), rel)
      else lines.push(`${rel}\0${createHash('sha256').update(await readFile(join(current, entry.name))).digest('hex')}`)
    }
  }
  await walk(directory, '')
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')
}

/* ------------------------------------------------------------------------- *
 * Interruptions
 * ------------------------------------------------------------------------- */

/** One fired probe: the durable stage, and the file it was reported for. */
interface FiredStage {
  readonly stage: CommitStage
  readonly target?: string
}

/**
 * The in-process seam: `arm` names the one durable stage — optionally the one
 * *file* of that stage — the probe throws at, so the intent stays open and no
 * later stage of that commit runs. The throw is not a process exit: it unwinds
 * through this process's own stack, `writeFileAtomic`'s `catch` removes the
 * staging file it wrote, and the instance that threw is still usable.
 */
function windowProbe(): {
  probe: (stage: CommitStage, target?: string) => void
  arm: (stage: CommitStage, target?: string) => void
  fired: FiredStage[]
} {
  const fired: FiredStage[] = []
  let armed: FiredStage | undefined
  return {
    fired,
    arm: (stage, target) => { armed = { stage, ...(target === undefined ? {} : { target }) } },
    probe: (stage, target) => {
      fired.push({ stage, ...(target === undefined ? {} : { target }) })
      if (armed === undefined || stage !== armed.stage || (armed.target !== undefined && target !== armed.target)) return
      armed = undefined
      throw new Error(`k3 fixture: the in-process probe threw after "${stage}" — a throw, not a process exit`)
    },
  }
}

/**
 * The real forced exit: a nested run of this very spec, told by env which window
 * to die at. `--pool=threads` is what makes the signal the parent observes the
 * case body's own, and `-t` keeps every other case of this spec — this spawner
 * included — out of the nested run.
 */
function spawnCommitChild(window: CommitStage, direction: CommitDirection, file: 'skill' | 'sidecar', workspace: string): SpawnSyncReturns<string> {
  const args = [
    join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--project', 'integration',
    '--pool=threads',
    SPEC_PATH,
    '-t', CHILD_CASE,
  ]
  return spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 180_000,
    env: {
      ...process.env,
      K3_REAL_EXIT_WINDOW: window,
      K3_REAL_EXIT_DIRECTION: direction,
      K3_REAL_EXIT_FILE: file,
      K3_REAL_EXIT_WORKSPACE: workspace,
    },
  })
}

/** What the parent proves about the child process image that performed the commit. */
interface ForcedExit {
  readonly window: CommitStage
  readonly direction: CommitDirection
  readonly file: 'skill' | 'sidecar'
  /** The child's own pid — the process image the commit ran in, and the one that is gone. */
  readonly pid: number
}

/** The null probe to a pid answered: `undefined` when it exists, `ESRCH` when it is gone. */
function pidProbe(pid: number): string | undefined {
  try {
    process.kill(pid, 0)
    return undefined
  } catch (error) {
    return (error as NodeJS.ErrnoException).code
  }
}

/**
 * The forced exit itself, asserted before anything about the durable state: the
 * nested run answered a *signal*, the marker it wrote before its commit names the
 * pid `spawnSync` started and not this process's, and that pid is dead.
 */
async function forcedExit(directory: string, child: SpawnSyncReturns<string>): Promise<ForcedExit> {
  const transcript = `nested run status ${String(child.status)}, signal ${String(child.signal)}, error ${String(child.error)}\n${child.stdout}\n${child.stderr}`
  expect(child.signal, `the nested run exited instead of being killed by its own commit — ${transcript}`).toBe('SIGKILL')
  expect(child.status, `a killed process has no exit code — ${transcript}`).toBeNull()
  const marker = JSON.parse(await readFile(join(directory, EXIT_MARKER), 'utf8')) as ForcedExit
  expect(marker.pid, 'the marker must name the process image that performed the commit, not the reader').not.toBe(process.pid)
  expect(marker.pid).toBe(child.pid)
  expect(pidProbe(marker.pid)).toBe('ESRCH')
  return marker
}

/**
 * Hand the child the session plane it cannot mint for itself, the way
 * `k2-evolution-commit.spec.ts` does: this fixture's persistence is memory, so a
 * second process image starts empty, while a deployment's next process simply
 * opens the log files its runs wrote.
 *
 * One difference from that spec's helper: the sessions this one carries include
 * the *replayed runs'* own logs. A spawn's request is recorded on its session's
 * log (which is the evidence the promotion gate re-reads), but this fixture
 * registers no header for it — and a session with a log but no header is one a
 * reader cannot enumerate. Both are carried here, verbatim, and nothing about a
 * session is transformed on the way.
 */
async function handOverSessions(h: RunStack, directory: string): Promise<void> {
  const persistence = sessionPersistenceOf(h)
  const sessions: { header: unknown; events: readonly unknown[] }[] = []
  const seen = new Set<string>()
  const carry = async (header: { id: unknown }): Promise<void> => {
    const id = String(header.id)
    if (seen.has(id)) return
    seen.add(id)
    let events: readonly unknown[]
    try {
      events = (await (await persistence.open(id)).read()).events
    } catch {
      // A run whose session never logged anything has nothing to carry.
      return
    }
    sessions.push({ header, events })
  }
  for (const entry of await persistence.list()) await carry(entry.header)
  for (const root of h.roots) {
    const snapshot = await h.task.snapshotIn(rootTaskStoreId(root)).catch(() => undefined)
    for (const run of snapshot?.runs ?? []) await carry({ id: run.sessionId, cwd: h.checkout, agentPreset: 'standard' })
  }
  await writeFile(join(directory, SESSION_HANDOVER), `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8')
}

/** The fixture's own persistence handle, as `run-stack.ts` mounts it. */
function sessionPersistenceOf(h: RunStack): {
  list(): Promise<{ header: { id: unknown } }[]>
  open(id: string): Promise<{ read(): Promise<{ events: readonly unknown[] }> }>
} {
  return (h.ctx as unknown as { get(name: string): never }).get('sessionPersistence')
}

/* ------------------------------------------------------------------------- *
 * The commit windows
 * ------------------------------------------------------------------------- */

/**
 * One durable window of one two-file commit, as a case names it: the stage, and —
 * for the two stages that fire once per file — the file of the object it is armed
 * for. `write-renamed@SKILL.md` is the mixed state: the new `SKILL.md` already
 * stands beside the old sidecar.
 */
interface CommitWindow {
  readonly label: string
  readonly stage: CommitStage
  readonly file: 'skill' | 'sidecar'
  /** What production holds after the interruption: `old` for both files, `mixed` for the SKILL.md moved, `new` for both. */
  readonly interrupted: 'old' | 'mixed' | 'new'
  /** What a reconciliation settles it to. */
  readonly result: 'completed-redone' | 'completed-written'
}

const APPLY_WINDOWS: readonly CommitWindow[] = [
  { label: 'intent-recorded', stage: 'intent-recorded', file: 'skill', interrupted: 'old', result: 'completed-redone' },
  { label: 'write-renamed @ SKILL.md', stage: 'write-renamed', file: 'skill', interrupted: 'mixed', result: 'completed-redone' },
  { label: 'write-renamed @ SKILL.contract.json', stage: 'write-renamed', file: 'sidecar', interrupted: 'new', result: 'completed-written' },
  { label: 'commit-verified', stage: 'commit-verified', file: 'skill', interrupted: 'new', result: 'completed-written' },
]

const ROLLBACK_WINDOWS: readonly CommitWindow[] = [
  { label: 'intent-recorded', stage: 'intent-recorded', file: 'skill', interrupted: 'old', result: 'completed-redone' },
  { label: 'write-renamed @ SKILL.md', stage: 'write-renamed', file: 'skill', interrupted: 'mixed', result: 'completed-redone' },
  { label: 'write-renamed @ SKILL.contract.json', stage: 'write-renamed', file: 'sidecar', interrupted: 'new', result: 'completed-written' },
  { label: 'commit-verified', stage: 'commit-verified', file: 'skill', interrupted: 'new', result: 'completed-written' },
]

/*
 * Both tables describe the same four windows of one commit — the stages fire in
 * the same order whichever direction runs, and `interrupted` names what the files
 * hold *relative to the commit* (`old` = the state before it, `new` = the content
 * it installs, `mixed` = the installed `SKILL.md` beside the file it had not
 * replaced yet). `COMMIT_WINDOW_STATES` spells out the mapping per direction in
 * {@link interruptedState}.
 */

/** The target a window's probe is armed for, given a window and the two production paths. */
function armedTarget(window: CommitWindow, h: RunStack, name: string = SKILL): string | undefined {
  if (window.stage !== 'write-renamed') return undefined
  return window.file === 'skill' ? productionSkill(h, name) : productionSidecar(h, name)
}

/**
 * The judge one case registers as a test double, so it can be *taken away*
 * again: the drift a deployment shows when a registrar moves after the human
 * decided. It judges the answer files the criteria name, like the built-in
 * `command` verifier, so the runs it decides are real runs.
 */
function testJudge(id: string, version: string): Verifier {
  const answerOf: Readonly<Record<string, string>> = { 'ac-fix': 'fix.txt', 'ac-keep': 'keep.txt', 'ac-holdout': 'holdout.txt' }
  return {
    id,
    version,
    supports: (mode: string) => mode === 'deterministic',
    verify: async (request: VerifyRequest): Promise<VerificationResult[]> => request.criteria.map(item => ({
      criterionId: item.criterionId,
      status: existsSync(join(request.cwd, answerOf[item.criterionId] ?? 'fix.txt')) ? 'pass' : 'fail',
      verifierId: id,
    })),
    selftest: {
      samples: [
        { name: 'positive', role: 'positive', expect: 'pass', criterion: { criterionId: 'ac-fix', description: 'x', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true } },
        { name: 'negative', role: 'negative', expect: 'fail', criterion: { criterionId: 'ac-fix', description: 'x', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true } },
      ],
    },
  } as unknown as Verifier
}

/* ------------------------------------------------------------------------- *
 * K3-1 — the whole object, end to end
 * ------------------------------------------------------------------------- */

describe('K3-1: a registered execution skill is improved and applied as one whole object', () => {
  it('fails on the old body and passes on the new one, and the derived two-file object lands through two real human gates', async () => {
    const s = await boot()
    const h = s.h
    const production = await writeSkillObject(join(h.home, 'skills'), {
      body: skillBody(SKILL, ['keep.txt', 'holdout.txt']),
      sidecar: 'execution',
    })
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
    await writeHistory(h, root.storeId)
    await mkdir(join(h.checkout, 'nested'), { recursive: true })
    await writeFile(join(h.checkout, 'input.txt'), 'the frozen input\n', 'utf8')

    const candidateBody = skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt'])
    const walked = await walkToGated(s, { proposalId: P1, content: candidateBody })
    const report = await reportOnDisk(h, walked.reportPath)
    expect(report).toEqual(walked.report)

    // --- the frozen block is the complete object on both ends, not a file digest ---
    const proposal = await s.svc.get(P1)
    expect(report.frozen.candidate).toEqual(proposal.prepared!.skillContent)
    expect(report.frozen.productionBaseline).toEqual(proposal.prepared!.skillBaseline)
    expect(report.frozen.candidate.contract).toBeDefined()
    expect(report.frozen.candidate.sha256).toBe(sha256Of(candidateBody))
    expect(report.frozen.productionBaseline!.contract!.sha256).toBe(production.identity.contract!.sha256)

    // --- the experiment's own verdict: fixed where the old body failed, nothing degraded ---
    expect(report.samples.map(sample => [sample.taskId, sample.role, sample.verdict])).toEqual([
      ['t-fix', 'observed-failure', 'fixed'],
      ['t-keep', 'observed-regression', 'maintained'],
      ['t-holdout', 'holdout', 'maintained'],
    ])
    expect(report.verdict).toBe('fixed')
    expect(side(report, 't-fix', 'baseline').outcome).toBe('failed')
    expect(side(report, 't-fix', 'candidate').outcome).toBe('verified')

    // --- each side really ran its own object, read out of the binding's own snapshot ---
    const candidateSha = sha256Of(candidateBody)
    const derived = derivedSidecar(JSON.parse(production.sidecar!), candidateSha)
    const derivedBytes = serializeSkillSidecar(derived as never)
    for (const sample of report.samples) {
      const baselineDetail = side(report, sample.taskId, 'baseline')
      const candidateDetail = side(report, sample.taskId, 'candidate')
      const baselineBinding = await bindingOf(h, root.storeId, baselineDetail.runId!)
      const candidateBinding = await bindingOf(h, root.storeId, candidateDetail.runId!)
      const baselineObject = await boundObject(baselineBinding)
      const candidateObject = await boundObject(candidateBinding)
      // The bytes: the baseline side ran production, the candidate side the derived object.
      expect(baselineObject).toEqual({ skillMd: production.skillMd, sidecar: production.sidecar })
      expect(candidateObject).toEqual({ skillMd: candidateBody, sidecar: derivedBytes })
      // …and the candidate's declaration is the production one with exactly one field
      // rewritten — compared field by field, not just by digest.
      const candidateDeclaration = JSON.parse(candidateObject.sidecar!) as Record<string, unknown>
      const productionDeclaration = JSON.parse(production.sidecar!) as Record<string, unknown>
      expect({ ...candidateDeclaration, content: null }).toEqual({ ...productionDeclaration, content: null })
      expect(candidateDeclaration.content).toEqual({ ...(productionDeclaration.content as object), skillMdSha256: candidateSha })
      // The declared digests agree with the bytes in the same snapshot (both files).
      expect(sha256Of(candidateObject.sidecar!)).toBe(report.frozen.candidate.contract!.sha256)
      expect(sha256Of(baselineObject.skillMd)).toBe(report.frozen.productionBaseline!.sha256)
      // Each side bound the revision and the provider identity the freeze recorded for it.
      const frozenSample = report.frozen.samples.find(item => item.taskId === sample.taskId)!
      expect(baselineBinding.registryRevision).toBe(frozenSample.provider.registryRevision)
      expect(candidateBinding.registryRevision).toBe(frozenSample.provider.candidateRegistryRevision)
      expect(candidateBinding.registryRevision).not.toBe(baselineBinding.registryRevision)
      expect(baselineBinding.skills).toEqual([expect.objectContaining({
        name: SKILL,
        role: 'execution-provider',
        contractDigest: report.frozen.productionBaseline!.contract!.contractDigest,
        contentDigest: skillContentDigest({ skillMdSha256: production.skillMdSha256, resources: [] }),
      })])
      expect(candidateBinding.skills).toEqual([expect.objectContaining({
        name: SKILL,
        role: 'execution-provider',
        contractDigest: report.frozen.candidate.contract!.contractDigest,
        contentDigest: skillContentDigest({ skillMdSha256: candidateSha, resources: [] }),
      })])
    }

    // --- the first human gate: the decision changes the ledger and nothing else ---
    const beforeDecision = await productionObject(h)
    await decideThroughTool(s, P1)
    expect(await productionObject(h)).toEqual(beforeDecision)
    expect(approvalCalls(h).map(call => call.toolName)).toEqual(['evolution_decide'])

    // --- the second human gate: the write ---
    await applyThroughTool(s, P1)
    expect(approvalCalls(h).map(call => call.toolName)).toEqual(['evolution_decide', 'evolution_apply'])
    expect(await productionObject(h)).toEqual({ skillMd: candidateBody, sidecar: derivedBytes })

    // --- one commit, two files: the intent named both, the completion closed both ---
    const lines = await ledgerLines(h)
    expect(lines.every(line => line.formatVersion === 4)).toBe(true)
    const intent = lines.filter(line => line.kind === 'commit_intent').at(-1)!
    const applied = lines.filter(line => line.kind === 'applied').at(-1)!
    expect(intent).toMatchObject({ proposalId: P1, direction: 'apply', intentId: `${P1}/apply` })
    expect(intentFiles(intent).map(file => file.target)).toEqual(commitTargets(h))
    expect(intentFiles(intent)[0]).toMatchObject({
      baselineSha256: production.identity.sha256,
      contentSha256: candidateSha,
      source: `sandbox/${P1}/skills/${SKILL}/SKILL.md`,
    })
    expect(intentFiles(intent)[1]).toMatchObject({
      baselineSha256: production.identity.contract!.sha256,
      contentSha256: sha256Of(derivedBytes),
      source: `sandbox/${P1}/skills/${SKILL}/${SKILL_SIDECAR_FILE}`,
    })
    expect(applied).toMatchObject({ proposalId: P1, intentId: `${P1}/apply`, targets: commitTargets(h) })
    expect(applied.approvalRef).toBe(intent.approvalRef)
    expect((await s.svc.get(P1)).status).toBe('applied')
    expect(await s.svc.openIntentTargets()).toEqual([])

    // --- the production declaration moved in exactly one field, and by derivation ---
    const appliedDeclaration = JSON.parse((await productionObject(h)).sidecar!) as Record<string, unknown>
    const originalDeclaration = JSON.parse(production.sidecar!) as Record<string, unknown>
    expect({ ...appliedDeclaration, content: null }).toEqual({ ...originalDeclaration, content: null })
    expect(appliedDeclaration.content).toEqual({ ...(originalDeclaration.content as object), skillMdSha256: candidateSha })
    expect(sha256Of((await productionObject(h)).sidecar!)).toBe(report.frozen.candidate.contract!.sha256)
    expect(sha256Of((await productionObject(h)).sidecar!)).not.toBe(production.identity.contract!.sha256)

    // --- the next run is admitted against the recovered object: both files ---
    const admitted = await admitChild(h, ROOT_A, root)
    const newBinding = await bindingOf(h, root.storeId, admitted.childRunId)
    expect(await boundObject(newBinding)).toEqual({ skillMd: candidateBody, sidecar: derivedBytes })
    expect(newBinding.registryRevision).toBe(report.frozen.samples[0]!.provider.candidateRegistryRevision)
    expect(newBinding.skills[0]).toMatchObject({
      role: 'execution-provider',
      contractDigest: report.frozen.candidate.contract!.contractDigest,
      contentDigest: skillContentDigest({ skillMdSha256: candidateSha, resources: [] }),
    })
    // The worker's own layer loaded the new body and acted on it.
    expect(await workerSkillFile(h, admitted.workerSessionId)).toBe(candidateBody)
    expect(await readFile(join(h.agent(admitted.workerSessionId)!.session.header.cwd, MARKER), 'utf8')).toBe(`${candidateSha}\n`)

    // --- a run bound to the previous version is not hot-swapped ---
    const oldBaseline = side(report, 't-fix', 'baseline')
    const oldBinding = await bindingOf(h, root.storeId, oldBaseline.runId!)
    expect(await boundObject(oldBinding)).toEqual({ skillMd: production.skillMd, sidecar: production.sidecar })
    expect((await h.task.runIn(root.storeId, oldBaseline.runId!)).providerBinding).toEqual(oldBinding)
    expect((await h.runtime.readRunBinding(oldBinding))?.defects).toEqual([])
    await h.runtime.submitResult(ROOT_A, { summary: 'the tree hands in the result its batch produced' })
  }, 180_000)
})

/* ------------------------------------------------------------------------- *
 * K3-2 — every refusal that happens before a write
 * ------------------------------------------------------------------------- */

/** The sandbox sidecar one prepared proposal materialized. */
function sandboxSidecar(h: RunStack, proposalId: string, name: string = SKILL): string {
  return join(ledgerRoot(h), 'sandbox', proposalId, 'skills', name, SKILL_SIDECAR_FILE)
}

describe('K3-2: the refusals that come before any write', () => {
  it('refuses to prepare a knowledge skill by name, writing no sandbox and no prepared line', async () => {
    const s = await boot({ quiet: true })
    const h = s.h
    await writeSkillObject(join(h.home, 'skills'), { body: skillBody(SKILL, ['keep.txt']), sidecar: 'knowledge' })
    const proposal = { proposalId: P1, level: 'L2', baseVersion: 'v1', targetType: 'skill', targetId: SKILL, rationale: 'improve it', sourceRefs: ['diagnosis:k3'] }
    expect((await s.call('evolution_propose', proposal)).isError).toBe(false)
    expect((await s.call('evolution_candidate', { proposalId: P1, versionSet: { skill: 'v2' }, mutationJson: JSON.stringify({ name: SKILL, content: skillBody(SKILL, ['fix.txt', 'keep.txt']) }) })).isError).toBe(false)

    const refused = await s.call('evolution_prepare', { proposalId: P1 })
    expect(refused.text).toContain('evolution_prepare rejected:')
    expect(refused.text).toContain('knowledge sidecar')
    expect(refused.text).toContain('nothing was written')
    expect(existsSync(join(ledgerRoot(h), 'sandbox'))).toBe(false)
    expect(kindsOf(await ledgerLines(h))).toEqual(['proposed', 'candidate'])
    expect((await s.call('evolution_prepare', { proposalId: P1 })).text).toContain('knowledge sidecar')
  })

  it('refuses to prepare a production object that declares resources, by name and with nothing written', async () => {
    const s = await boot({ quiet: true })
    const h = s.h
    await writeSkillObject(join(h.home, 'skills'), {
      body: skillBody(SKILL, ['keep.txt']),
      sidecar: 'execution',
      resources: [{ path: 'references/notes.md', bytes: 'the declared notes\n' }],
    })
    await s.call('evolution_propose', { proposalId: P1, level: 'L2', baseVersion: 'v1', targetType: 'skill', targetId: SKILL, rationale: 'improve it', sourceRefs: ['diagnosis:k3'] })
    await s.call('evolution_candidate', { proposalId: P1, versionSet: { skill: 'v2' }, mutationJson: JSON.stringify({ name: SKILL, content: skillBody(SKILL, ['fix.txt', 'keep.txt']) }) })

    const refused = await s.call('evolution_prepare', { proposalId: P1 })
    expect(refused.text).toContain('evolution_prepare rejected:')
    expect(refused.text).toContain('resource(s)')
    expect(refused.text).toContain('nothing was written')
    expect(existsSync(join(ledgerRoot(h), 'sandbox'))).toBe(false)
    expect(kindsOf(await ledgerLines(h))).toEqual(['proposed', 'candidate'])
  })

  it.each([
    { label: 'a file at a supported resource position', file: 'references/notes.md' },
    { label: 'an entry outside the supported vocabulary', file: 'helper.sh' },
  ])('refuses to prepare a guidance object that leaves a file undeclared — $label', async ({ file }) => {
    const s = await boot({ quiet: true })
    const h = s.h
    // Guidance: no sidecar anywhere, so nothing declares this file and nothing
    // covers it — the one shape where the loader has no declaration to compare
    // against and the file would otherwise be left behind silently.
    await writeSkillObject(join(h.home, 'skills'), {
      body: skillBody(SKILL, ['keep.txt']),
      resources: [{ path: file, bytes: 'a file nobody declared\n' }],
    })
    await s.call('evolution_propose', { proposalId: P1, level: 'L2', baseVersion: 'v1', targetType: 'skill', targetId: SKILL, rationale: 'improve it', sourceRefs: ['diagnosis:k3'] })
    await s.call('evolution_candidate', { proposalId: P1, versionSet: { skill: 'v2' }, mutationJson: JSON.stringify({ name: SKILL, content: skillBody(SKILL, ['fix.txt', 'keep.txt']) }) })

    const refused = await s.call('evolution_prepare', { proposalId: P1 })
    expect(refused.text).toContain('evolution_prepare rejected:')
    expect(refused.text).toContain(file)
    expect(refused.text).toContain('nothing was written')
    expect(existsSync(join(ledgerRoot(h), 'sandbox'))).toBe(false)
    expect(kindsOf(await ledgerLines(h))).toEqual(['proposed', 'candidate'])
    expect((await s.svc.get(P1)).status).toBe('candidate')

    // The service entry behind the tool refuses the same way, and still writes
    // nothing: the refusal is prepare's own, not the tool's rendering of it.
    const direct = await s.svc.prepare(P1, ROOT_A)
      .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(direct).toContain(file)
    expect(direct).toContain('nothing was written')
    expect(existsSync(join(ledgerRoot(h), 'sandbox'))).toBe(false)
    expect(kindsOf(await ledgerLines(h))).toEqual(['proposed', 'candidate'])
    expect((await s.svc.get(P1)).status).toBe('candidate')
  })

  it('refuses a production declaration whose content digest is not the bytes it covers, before anything is frozen', async () => {
    const s = await boot({ quiet: true })
    const h = s.h
    await writeSkillObject(join(h.home, 'skills'), {
      body: skillBody(SKILL, ['keep.txt']),
      sidecar: 'execution',
      declaredSkillMdSha256: 'f'.repeat(64),
    })
    await s.call('evolution_propose', { proposalId: P1, level: 'L2', baseVersion: 'v1', targetType: 'skill', targetId: SKILL, rationale: 'improve it', sourceRefs: ['diagnosis:k3'] })
    await s.call('evolution_candidate', { proposalId: P1, versionSet: { skill: 'v2' }, mutationJson: JSON.stringify({ name: SKILL, content: skillBody(SKILL, ['fix.txt', 'keep.txt']) }) })

    const refused = await s.call('evolution_prepare', { proposalId: P1 })
    expect(refused.text).toContain('evolution_prepare rejected:')
    expect(refused.text).toContain('content-mismatch:')
    expect(existsSync(join(ledgerRoot(h), 'sandbox'))).toBe(false)
    expect(kindsOf(await ledgerLines(h))).toEqual(['proposed', 'candidate'])
  })

  it.each([
    { label: 'a non-digest field (requiredTools) moved', move: (declaration: Record<string, unknown>) => ({ ...declaration, requiredTools: ['bash'] }) },
    { label: 'the content digest no longer matches the candidate body', move: (declaration: Record<string, unknown>) => ({ ...declaration, content: { ...(declaration.content as object), skillMdSha256: '0'.repeat(64) } }) },
  ])('refuses the apply when the sandbox sidecar was rewritten after prepare — $label', async ({ move }) => {
    const s = await boot()
    const h = s.h
    await writeSkillObject(join(h.home, 'skills'), { body: skillBody(SKILL, ['keep.txt', 'holdout.txt']), sidecar: 'execution' })
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
    await writeHistory(h, root.storeId)
    await mkdir(join(h.checkout, 'nested'), { recursive: true })
    await walkToGated(s, { proposalId: P1, content: skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt']) })
    await decideThroughTool(s, P1)

    const path = sandboxSidecar(h, P1)
    const rewritten = move(JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>)
    await writeFile(path, serializeSkillSidecar(rewritten as never), 'utf8')
    const before = await ledgerBytes(h)
    const productionBefore = await productionObject(h)
    const approvalsBefore = approvalCalls(h).length

    const refused = await s.call('evolution_apply', { proposalId: P1 })
    expect(refused.text).toContain('evolution_apply rejected:')
    expect(refused.text).toContain('no longer matches the content identity recorded at prepare')
    // Nothing was written and nothing was recorded — and no human was asked.
    expect(await productionObject(h)).toEqual(productionBefore)
    expect(await ledgerBytes(h)).toBe(before)
    expect(kindsOf(await ledgerLines(h)).slice(-1)).toEqual(['decided'])
    expect(approvalCalls(h)).toHaveLength(approvalsBefore)
    // The service entry says the same thing, not only the tool.
    const direct = await s.svc.apply(P1, ROOT_A, 'approval:k3-direct')
      .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(direct).toContain('no longer matches the content identity recorded at prepare')
    expect(await ledgerBytes(h)).toBe(before)
  }, 180_000)

  it('refuses a candidate whose SKILL.md declares another name, where the object is admitted', async () => {
    const s = await boot()
    const h = s.h
    const production = await writeSkillObject(join(h.home, 'skills'), { body: skillBody(SKILL, ['keep.txt', 'holdout.txt']), sidecar: 'execution' })
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
    await writeHistory(h, root.storeId)
    await mkdir(join(h.checkout, 'nested'), { recursive: true })
    await s.call('evolution_propose', { proposalId: P1, level: 'L2', baseVersion: 'v1', targetType: 'skill', targetId: SKILL, rationale: 'improve it', sourceRefs: ['diagnosis:k3'] })
    // The model's own text names another skill: `prepare` materializes exactly the
    // bytes it was handed, so the object the candidate side would load declares a
    // name the row does not grant.
    const renamed = skillBody('k3-a-different-skill-name', ['fix.txt', 'keep.txt', 'holdout.txt'])
    await s.call('evolution_candidate', { proposalId: P1, versionSet: { skill: 'v2' }, mutationJson: JSON.stringify({ name: SKILL, content: renamed }) })
    expect((await s.call('evolution_prepare', { proposalId: P1 })).text).toContain('[prepared]')

    const spawnsBefore = h.spawns.length
    const refused = await s.call('evolution_replay', { proposalId: P1, taskIds: [...SAMPLES], holdoutTaskIds: [...HOLDOUT] })
    expect(refused.text).toContain('evolution_replay rejected:')
    expect(refused.text).toContain('skill-name-mismatch')
    expect(refused.text).toContain(join(ledgerRoot(h), 'sandbox', P1, 'skills', SKILL))

    // No promotion can be reached from here: nothing is gated, nothing is decided,
    // nothing is written, and no human is asked.
    const kinds = kindsOf(await ledgerLines(h))
    expect(kinds.slice(0, 3)).toEqual(['proposed', 'candidate', 'prepared'])
    expect(kinds).not.toContain('gated')
    expect(kinds).not.toContain('decided')
    expect(kinds).not.toContain('commit_intent')
    expect((await s.svc.get(P1)).status).toBe('prepared')
    expect(await productionObject(h)).toEqual({ skillMd: production.skillMd, sidecar: production.sidecar })
    expect(approvalCalls(h).map(call => call.toolName)).toEqual([])
    expect(h.spawns.length).toBeGreaterThanOrEqual(spawnsBefore)
  }, 180_000)

  it('refuses the apply when the judge the declaration pins was unregistered after the decision', async () => {
    const s = await boot()
    const h = s.h
    const offJudge = await h.verifier.register(testJudge('k3-judge', '1'), { testDouble: true })
    try {
      await writeSkillObject(join(h.home, 'skills'), {
        body: skillBody(SKILL, ['keep.txt', 'holdout.txt']),
        sidecar: 'execution',
        verifierRef: 'k3-judge',
      })
      const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
      await writeHistory(h, root.storeId)
      await mkdir(join(h.checkout, 'nested'), { recursive: true })
      await walkToGated(s, { proposalId: P1, content: skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt']) })
      await decideThroughTool(s, P1)

      // The registrar moves after the human decided: the judge the declaration
      // counts on is gone, so the write must not go ahead.
      offJudge()
      const before = await ledgerBytes(h)
      const productionBefore = await productionObject(h)
      const refused = await s.call('evolution_apply', { proposalId: P1 })
      expect(refused.text).toContain('evolution_apply rejected:')
      expect(refused.text).toContain('verifier-unknown')
      expect(refused.text).toContain('k3-judge')
      expect(await productionObject(h)).toEqual(productionBefore)
      expect(await ledgerBytes(h)).toBe(before)
      expect((await s.svc.get(P1)).status).toBe('decided')
    } finally {
      offJudge()
    }
  }, 180_000)

  it('refuses the apply when the capability grant the promotion counted on is gone', async () => {
    const s = await boot()
    const h = s.h
    await writeSkillObject(join(h.home, 'skills'), { body: skillBody(SKILL, ['keep.txt', 'holdout.txt']), sidecar: 'execution' })
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
    await writeHistory(h, root.storeId)
    await mkdir(join(h.checkout, 'nested'), { recursive: true })
    await walkToGated(s, { proposalId: P1, content: skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt']) })
    await decideThroughTool(s, P1)

    // The row that grants the skill is withdrawn before the write: the declaration
    // the promotion would install names a capability the deployment no longer
    // holds, so the grant is not the one the candidate was evaluated under.
    expect(h.runtime.listCapabilities()[ROW]).toBeDefined()
    await h.runtime.applyCapabilityRow(ROW, null)
    expect(h.runtime.listCapabilities()[ROW]).toBeUndefined()

    const before = await ledgerBytes(h)
    const productionBefore = await productionObject(h)
    const refused = await s.call('evolution_apply', { proposalId: P1 })
    expect(refused.text).toContain('evolution_apply rejected:')
    expect(refused.text).toContain('capability-unknown')
    expect(refused.text).toContain(ROW)
    expect(await productionObject(h)).toEqual(productionBefore)
    expect(await ledgerBytes(h)).toBe(before)
    expect((await s.svc.get(P1)).status).toBe('decided')
  }, 180_000)

  it('refuses to freeze an experiment for a provider whose required tools its row does not grant, starting no run', async () => {
    const s = await boot({ capabilities: { [ROW]: { skills: [SKILL], tools: ['filesystem'] } } })
    const h = s.h
    await writeSkillObject(join(h.home, 'skills'), {
      body: skillBody(SKILL, ['keep.txt', 'holdout.txt']),
      sidecar: 'execution',
      requiredTools: ['bash'],
    })
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
    await writeHistory(h, root.storeId)
    await mkdir(join(h.checkout, 'nested'), { recursive: true })
    await s.call('evolution_propose', { proposalId: P1, level: 'L2', baseVersion: 'v1', targetType: 'skill', targetId: SKILL, rationale: 'improve it', sourceRefs: ['diagnosis:k3'] })
    await s.call('evolution_candidate', { proposalId: P1, versionSet: { skill: 'v2' }, mutationJson: JSON.stringify({ name: SKILL, content: skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt']) }) })
    expect((await s.call('evolution_prepare', { proposalId: P1 })).isError).toBe(false)

    const spawnsBefore = h.spawns.length
    const refused = await s.call('evolution_replay', { proposalId: P1, taskIds: [...SAMPLES], holdoutTaskIds: [...HOLDOUT] })
    expect(refused.text).toContain('evolution_replay rejected:')
    expect(refused.text).toContain('tool-not-covered:')
    expect(refused.text).toContain('bash')
    expect(kindsOf(await ledgerLines(h))).toEqual(['proposed', 'candidate', 'prepared'])
    expect(h.spawns).toHaveLength(spawnsBefore)
  }, 180_000)

  it('still promotes a guidance skill through the whole chain, one file at a time', async () => {
    const s = await boot()
    const h = s.h
    // The one file the guidance object has, with no declaration anywhere near it.
    const guidance = await writeSkillObject(join(h.home, 'skills'), { name: CLEAN_SKILL, body: skillBody(CLEAN_SKILL, ['keep.txt', 'holdout.txt']) })
    expect(guidance.sidecar).toBeUndefined()
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate guidance skill'))
    await writeSample(h, root.storeId, { taskId: 't-fix', runId: 'r-fix-history', objective: 'the answer file is produced', acceptance: criterion('ac-fix', 'test -f fix.txt'), outcome: 'failed', capability: GUIDE_ROW })
    await writeSample(h, root.storeId, { taskId: 't-holdout', runId: 'r-holdout-history', objective: 'the held-out answer file is produced', acceptance: criterion('ac-holdout', 'test -f holdout.txt'), outcome: 'verified', capability: GUIDE_ROW })
    await mkdir(join(h.checkout, 'nested'), { recursive: true })

    const candidateBody = skillBody(CLEAN_SKILL, ['fix.txt', 'holdout.txt'])
    const walked = await walkToGated(s, {
      proposalId: P2,
      name: CLEAN_SKILL,
      content: candidateBody,
      samples: ['t-fix'],
      holdout: ['t-holdout'],
    })
    expect(walked.report.frozen.candidate.contract).toBeUndefined()
    expect(walked.report.verdict).toBe('fixed')
    await decideThroughTool(s, P2)
    await applyThroughTool(s, P2)

    // One file, replaced; and no declaration appeared beside it.
    expect(await readFile(productionSkill(h, CLEAN_SKILL), 'utf8')).toBe(candidateBody)
    expect(existsSync(productionSidecar(h, CLEAN_SKILL))).toBe(false)
    const lines = await ledgerLines(h)
    const intent = lines.filter(line => line.kind === 'commit_intent').at(-1)!
    expect(intentFiles(intent).map(file => file.target)).toEqual([productionSkill(h, CLEAN_SKILL)])
    expect(intentFiles(intent)[0]).toMatchObject({ baselineSha256: guidance.skillMdSha256, contentSha256: sha256Of(candidateBody) })
    expect(lines.filter(line => line.kind === 'applied').at(-1)!.targets).toEqual([productionSkill(h, CLEAN_SKILL)])

    const admitted = await admitChild(h, ROOT_A, root, GUIDE_ROW)
    const binding = await bindingOf(h, root.storeId, admitted.childRunId)
    expect(await boundObject(binding, CLEAN_SKILL)).toEqual({ skillMd: candidateBody })
    expect(binding.skills[0]).toMatchObject({ role: 'guidance', contractDigest: null })
    await h.runtime.submitResult(ROOT_A, { summary: 'the tree hands in the result its batch produced' })
  }, 180_000)
})

/* ------------------------------------------------------------------------- *
 * K3-3 — drift after the freeze
 * ------------------------------------------------------------------------- */

describe('K3-3: a file that moves after the freeze refuses by name, and the two sides stay complete and isolated', () => {
  it.each([
    { label: 'the candidate SKILL.md', file: 'SKILL.md' },
    { label: 'the candidate SKILL.contract.json', file: SKILL_SIDECAR_FILE },
  ])('refuses to freeze the experiment when $label moved in the sandbox after prepare, starting nothing', async ({ file }) => {
    const s = await boot()
    const h = s.h
    await writeSkillObject(join(h.home, 'skills'), { body: skillBody(SKILL, ['keep.txt', 'holdout.txt']), sidecar: 'execution' })
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
    await writeHistory(h, root.storeId)
    await mkdir(join(h.checkout, 'nested'), { recursive: true })
    await s.call('evolution_propose', { proposalId: P1, level: 'L2', baseVersion: 'v1', targetType: 'skill', targetId: SKILL, rationale: 'improve it', sourceRefs: ['diagnosis:k3'] })
    await s.call('evolution_candidate', { proposalId: P1, versionSet: { skill: 'v2' }, mutationJson: JSON.stringify({ name: SKILL, content: skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt']) }) })
    expect((await s.call('evolution_prepare', { proposalId: P1 })).text).toContain('[prepared]')

    // The sandbox file moves after the prepare recorded its identity — the state
    // every later stage must refuse rather than evaluate.
    const at = join(ledgerRoot(h), 'sandbox', P1, 'skills', SKILL, file)
    await writeFile(at, file === 'SKILL.md'
      ? `${skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt'])}the sandbox was rewritten after prepare\n`
      : serializeSkillSidecar({ ...(JSON.parse(await readFile(at, 'utf8')) as Record<string, unknown>), requiredTools: ['bash'] } as never), 'utf8')

    const spawnsBefore = h.spawns.length
    const refused = await s.call('evolution_replay', { proposalId: P1, taskIds: [...SAMPLES], holdoutTaskIds: [...HOLDOUT] })
    expect(refused.text).toContain('evolution_replay rejected:')
    expect(refused.text).toContain('no longer matches the content identity recorded at prepare')
    expect(kindsOf(await ledgerLines(h))).toEqual(['proposed', 'candidate', 'prepared'])
    expect(h.spawns).toHaveLength(spawnsBefore)
    expect((await s.svc.get(P1)).status).toBe('prepared')
  }, 180_000)

  it.each([
    { label: 'the production SKILL.md', file: 'SKILL.md' },
    { label: 'the production SKILL.contract.json', file: SKILL_SIDECAR_FILE },
  ])('refuses the write when $label moved after the decision, and never overwrites it', async ({ file }) => {
    const s = await boot()
    const h = s.h
    const production = await writeSkillObject(join(h.home, 'skills'), { body: skillBody(SKILL, ['keep.txt', 'holdout.txt']), sidecar: 'execution' })
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
    await writeHistory(h, root.storeId)
    await mkdir(join(h.checkout, 'nested'), { recursive: true })
    await walkToGated(s, { proposalId: P1, content: skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt']) })
    await decideThroughTool(s, P1)

    // A third party rewrites one of the two production files the commit would
    // replace: the baseline prepare recorded is gone, so the write is refused.
    const at = file === 'SKILL.md' ? productionSkill(h) : productionSidecar(h)
    const thirdParty = file === 'SKILL.md'
      ? skillBody(SKILL, ['keep.txt', 'holdout.txt'], 'a third party rewrote the body')
      : serializeSkillSidecar({ ...(JSON.parse(production.sidecar!) as Record<string, unknown>), precondition: 'a third party rewrote the declaration' } as never)
    await writeFile(at, thirdParty, 'utf8')

    const before = await ledgerBytes(h)
    const approvalsBefore = approvalCalls(h).length
    const refused = await s.call('evolution_apply', { proposalId: P1 })
    expect(refused.text).toContain('evolution_apply rejected:')
    expect(refused.text).toContain('changed since prepare')
    expect(await ledgerBytes(h)).toBe(before)
    expect(kindsOf(await ledgerLines(h)).slice(-1)).toEqual(['decided'])
    expect(approvalCalls(h)).toHaveLength(approvalsBefore)
    // The third party's bytes stand exactly as they were left.
    expect(await readFile(at, 'utf8')).toBe(thirdParty)
    expect(await readFile(file === 'SKILL.md' ? productionSidecar(h) : productionSkill(h), 'utf8'))
      .toBe(file === 'SKILL.md' ? production.sidecar! : production.skillMd)
    // A source that moved is the same refusal, asked of the service entry directly.
    const direct = await s.svc.apply(P1, ROOT_A, 'approval:k3-direct')
      .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(direct).toContain('changed since prepare')
    expect(await ledgerBytes(h)).toBe(before)
  }, 180_000)

  it('runs both sides of every sample as complete, isolated objects from one frozen input', async () => {
    const s = await boot()
    const h = s.h
    const production = await writeSkillObject(join(h.home, 'skills'), { body: skillBody(SKILL, ['keep.txt', 'holdout.txt']), sidecar: 'execution' })
    const root = await h.root(ROOT_A, rootContract('evaluate the candidate execution skill'))
    await writeHistory(h, root.storeId)
    await mkdir(join(h.checkout, 'nested'), { recursive: true })
    await writeFile(join(h.checkout, 'input.txt'), 'the frozen input\n', 'utf8')

    const candidateBody = skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt'])
    const walked = await walkToGated(s, { proposalId: P1, content: candidateBody })
    const report = walked.report

    // The frozen input is the caller's own workspace, digested independently here.
    expect(report.frozen.snapshot.digest).toBe(await independentDigest(h.checkout))
    const candidateSha = sha256Of(candidateBody)
    for (const sample of report.samples) {
      const baseline = side(report, sample.taskId, 'baseline')
      const candidate = side(report, sample.taskId, 'candidate')
      const frozenSample = report.frozen.samples.find(item => item.taskId === sample.taskId)!
      // The historical record locates the case; it is nobody's baseline.
      expect(baseline.taskId).not.toBe(sample.taskId)
      expect(candidate.taskId).not.toBe(sample.taskId)
      expect(baseline.runId).not.toBe(frozenSample.observed.runId)
      expect(candidate.runId).not.toBe(frozenSample.observed.runId)
      expect(baseline.workspace).not.toBe(candidate.workspace)
      for (const [detail, object] of [
        [baseline, report.frozen.productionBaseline!],
        [candidate, report.frozen.candidate],
      ] as const) {
        // Each workspace started from the frozen input…
        expect(detail.initialDigest).toBe(report.frozen.snapshot.digest)
        // …wrote only in its own copy, and recorded the object it really loaded.
        expect(await readFile(join(detail.workspace!, MARKER), 'utf8')).toBe(`${object.sha256}\n`)
        const binding = await bindingOf(h, root.storeId, detail.runId!)
        const bound = await boundObject(binding)
        expect(sha256Of(bound.skillMd)).toBe(object.sha256)
        expect(sha256Of(bound.sidecar!)).toBe(object.contract!.sha256)
      }
      // Neither side holds the other's object: the two markers are the two identities.
      const baselineMarker = await readFile(join(baseline.workspace!, MARKER), 'utf8')
      expect(baselineMarker).toBe(`${report.frozen.productionBaseline!.sha256}\n`)
      expect(baselineMarker).not.toBe(`${candidateSha}\n`)
    }
    // The sides wrote their copies, never the frozen input itself.
    expect(existsSync(join(h.checkout, MARKER))).toBe(false)
    expect(existsSync(join(h.checkout, 'fix.txt'))).toBe(false)
    expect(await independentDigest(h.checkout)).toBe(report.frozen.snapshot.digest)
    // And production still holds exactly what it held before the experiment.
    expect(await productionObject(h)).toEqual({ skillMd: production.skillMd, sidecar: production.sidecar })
  }, 180_000)
})

/* ------------------------------------------------------------------------- *
 * K3-4 — the two-file commit, interrupted and recovered
 * ------------------------------------------------------------------------- */

/** The world one commit window starts from, rebuilt here so the in-process and the killed cases assert the same thing. */
interface DecidedWorld {
  readonly s: UnitStack
  readonly probe: ReturnType<typeof windowProbe>
  readonly production: InstalledSkill
  readonly candidateBody: string
  readonly derivedBytes: string
  readonly root: { storeId: string; taskId: string; runId: string }
}

/**
 * One execution skill in production, one proposal walked to `decided` through the
 * real tools over a completed two-sided experiment, and the probe attached to the
 * evolution plane — the state every commit window below starts from.
 */
async function decidedWorld(directory: string): Promise<DecidedWorld> {
  const probe = windowProbe()
  const s = await boot({ workspace: directory, commitProbe: probe.probe })
  const h = s.h
  const production = await writeSkillObject(join(h.home, 'skills'), {
    body: skillBody(SKILL, ['keep.txt', 'holdout.txt']),
    sidecar: 'execution',
  })
  const root = await h.root(ROOT_A, rootContract('improve the fixture skill'))
  await writeHistory(h, root.storeId)
  await mkdir(join(h.checkout, 'nested'), { recursive: true })
  await writeFile(join(h.checkout, 'input.txt'), 'the frozen input\n', 'utf8')
  const candidateBody = skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt'])
  await walkToGated(s, { proposalId: P1, content: candidateBody })
  await decideThroughTool(s, P1)
  return {
    s,
    probe,
    production,
    candidateBody,
    derivedBytes: serializeSkillSidecar(derivedSidecar(JSON.parse(production.sidecar!), sha256Of(candidateBody)) as never),
    root,
  }
}

/** One of the two complete versions a two-file commit moves between. */
function sideState(world: DecidedWorld, which: 'production' | 'candidate'): { skillMd: string; sidecar?: string } {
  return which === 'production'
    ? { skillMd: world.production.skillMd, sidecar: world.production.sidecar }
    : { skillMd: world.candidateBody, sidecar: world.derivedBytes }
}

/** What production holds in the middle of one interrupted window: the pre-commit state, the committed one, or the mixed pair. */
function interruptedState(world: DecidedWorld, direction: CommitDirection, window: CommitWindow): { skillMd: string; sidecar?: string } {
  const from = direction === 'apply' ? 'production' : 'candidate'
  const to = direction === 'apply' ? 'candidate' : 'production'
  if (window.interrupted === 'old') return sideState(world, from)
  if (window.interrupted === 'new') return sideState(world, to)
  // The mixed state a death between the two renames leaves: the committed
  // `SKILL.md` beside the sidecar the commit had not replaced yet.
  return { skillMd: sideState(world, to).skillMd, sidecar: sideState(world, from).sidecar }
}

/** What production must hold once the intent is settled: the version this direction committed. */
function settledState(world: DecidedWorld, direction: CommitDirection): { skillMd: string; sidecar?: string } {
  return sideState(world, direction === 'apply' ? 'candidate' : 'production')
}

/** The candidate object's own content identity, as `prepare` recorded it for this world. */
function candidateIdentity(world: DecidedWorld): SkillContentIdentity {
  return {
    name: SKILL,
    sha256: sha256Of(world.candidateBody),
    contract: { sha256: sha256Of(world.derivedBytes), contractDigest: skillContractDigest(JSON.parse(world.derivedBytes) as never) },
  }
}

/**
 * What the interruption left is one of the two complete versions — or, in the
 * mixed window, exactly the committed `SKILL.md` beside the sidecar that had not
 * been replaced yet. Neither complete object describes the mixed pair.
 */
function assertInterruptedState(world: DecidedWorld, direction: CommitDirection, window: CommitWindow, held: { skillMd: string; sidecar?: string }): void {
  const committed = direction === 'apply' ? candidateIdentity(world) : world.production.identity
  const previous = direction === 'apply' ? world.production.identity : candidateIdentity(world)
  const current = objectIdentity(SKILL, held)
  if (window.interrupted === 'mixed') {
    expect({ sha256: current.sha256, contract: current.contract!.sha256 })
      .toEqual({ sha256: committed.sha256, contract: previous.contract!.sha256 })
    expect(current.contract!.sha256).not.toBe(committed.contract!.sha256)
    return
  }
  const expected = window.interrupted === 'old' ? previous : committed
  expect({ sha256: current.sha256, contract: current.contract!.sha256 })
    .toEqual({ sha256: expected.sha256, contract: expected.contract!.sha256 })
}

/** The completion kind one direction records. */
function completionKind(direction: CommitDirection): string {
  return direction === 'apply' ? 'applied' : 'rolledback'
}

/**
 * Everything a settled intent must show, read off disk: production is the
 * complete target version, the intent is closed by exactly one completion
 * carrying its own grant and both targets, nothing is left open, and a second
 * reconciliation is free.
 */
async function settledComplete(input: {
  reopened: UnitStack
  direction: CommitDirection
  intent: Record<string, unknown>
  walked: readonly string[]
  target: { skillMd: string; sidecar?: string }
}): Promise<void> {
  const { reopened, direction, intent, walked, target } = input
  const h = reopened.h
  const kind = completionKind(direction)
  expect(await productionObject(h)).toEqual(target)
  const settled = await ledgerLines(h)
  expect(kindsOf(settled)).toEqual([...walked, 'commit_intent', kind])
  const completions = settled.filter(line => line.kind === kind)
  expect(completions).toHaveLength(1)
  expect(completions[0]).toMatchObject({
    proposalId: P1,
    intentId: `${P1}/${direction}`,
    approvalRef: intent.approvalRef,
    targets: commitTargets(h),
  })
  expect(await stagedNow(h)).toEqual([])
  expect(await reopened.svc.openIntentTargets()).toEqual([])
  expect((await reopened.svc.get(P1)).status).toBe(kind)
  const stable = await ledgerBytes(h)
  expect(await reopened.svc.reconcile()).toEqual([])
  expect(await ledgerBytes(h)).toBe(stable)
}

/** Every staging file left in the skill directory (a settled commit removes its own, always). */
async function stagedNow(h: RunStack, name: string = SKILL): Promise<string[]> {
  return stagingFiles(productionDirectory(h, name))
}

describe('K3-4: a two-file commit interrupted between two durable writes is settled by the process that reopens the directory', () => {
  it.each(APPLY_WINDOWS)('settles an apply interrupted after $label, and the reopened host lands both files', async window => {
    const directory = await sharedDirectory()
    const world = await decidedWorld(directory)
    const h = world.s.h
    const targets = commitTargets(h)
    const walked = kindsOf(await ledgerLines(h))
    expect(walked.at(-1)).toBe('decided')
    expect(await productionObject(h)).toEqual(sideState(world, 'production'))

    // The commit dies inside itself, at the stage — and the file — armed for.
    const armed = armedTarget(window, h)
    world.probe.arm(window.stage, armed)
    await expect(world.s.svc.apply(P1, ROOT_A, 'approval:k3-apply')).rejects.toThrow(/in-process probe threw after/)
    const fired = world.probe.fired.at(-1)!
    expect(fired.stage).toBe(window.stage)
    expect(fired.target).toBe(armed)

    // What the interruption left: one open intent naming both files, and no completion.
    const interrupted = await ledgerLines(h)
    expect(kindsOf(interrupted)).toEqual([...walked, 'commit_intent'])
    const intent = interrupted.at(-1)!
    expect(intent).toMatchObject({ kind: 'commit_intent', intentId: `${P1}/apply`, proposalId: P1, direction: 'apply', approvalRef: 'approval:k3-apply' })
    expect(intentFiles(intent).map(file => file.target)).toEqual(targets)
    expect(intentFiles(intent)[0]).toMatchObject({
      baselineSha256: world.production.identity.sha256,
      contentSha256: sha256Of(world.candidateBody),
      source: `sandbox/${P1}/skills/${SKILL}/SKILL.md`,
    })
    expect(intentFiles(intent)[1]).toMatchObject({
      baselineSha256: world.production.identity.contract!.sha256,
      contentSha256: sha256Of(world.derivedBytes),
      source: `sandbox/${P1}/skills/${SKILL}/${SKILL_SIDECAR_FILE}`,
    })
    const left = interruptedState(world, 'apply', window)
    expect(await productionObject(h)).toEqual(left)
    expect(await stagedNow(h)).toEqual([])
    expect(await world.s.svc.openIntentTargets()).toEqual(targets)
    // The mixed pair is one complete object neither version describes — a state
    // only the window can produce, and one nothing may load.
    assertInterruptedState(world, 'apply', window, left)

    // The reopen: a second process image over the same directory, reading the
    // ledger and both production files off disk.
    // The first boot hands its checkout back — settling the tree it activated is
    // what releases the claim a second process image would otherwise find busy.
    await h.runtime.submitResult(ROOT_A, { summary: 'the first boot hands its checkout back' })

    const reopened = await boot({ workspace: directory })
    const h2 = reopened.h
    expect(await reopened.svc.openIntentTargets()).toEqual(targets)
    expect(await productionObject(h2)).toEqual(left)
    // While the intent stands the whole directory is refused, whatever each file
    // holds — the mixed state included. The refusal names the unfinished commit.
    await expect(h2.root(ROOT_B, rootContract('ship the interrupted release', [ROW]))).rejects.toThrow(/commit-intent-open/)

    // The host's own recovery entry: the barrier a restart runs before it takes a store over.
    const adoptedStore = rootTaskStoreId(ROOT_A)
    await h2.task.createStore(adoptedStore)
    const warnings = captureWarnings(h2)
    const adoption = await h2.runtime.adoptRoot(adoptedStore, ROOT_A)
    expect(adoption.adopted).toBe(false)
    expect(warnings.filter(line => line.includes('could not be settled'))).toEqual([])

    await settledComplete({ reopened, direction: 'apply', intent, walked, target: sideState(world, 'candidate') })

    // A run admitted after the recovery loads the complete new object.
    const root = await h2.root(ROOT_A, rootContract('ship the recovered release'))
    const admitted = await admitChild(h2, ROOT_A, root)
    expect(await boundObject(await bindingOf(h2, root.storeId, admitted.childRunId))).toEqual(sideState(world, 'candidate'))
    await h2.runtime.submitResult(ROOT_A, { summary: 'the tree hands in the result its batch produced' })
  }, 180_000)

  it.each(ROLLBACK_WINDOWS)('settles a rollback interrupted after $label, and the reopened host restores both files', async window => {
    const directory = await sharedDirectory()
    const world = await decidedWorld(directory)
    const h = world.s.h
    const targets = commitTargets(h)
    // The world a rollback starts from: the apply that landed, whole.
    await world.s.svc.apply(P1, ROOT_A, 'approval:k3-apply')
    expect(await productionObject(h)).toEqual(sideState(world, 'candidate'))
    const applied = kindsOf(await ledgerLines(h))
    expect(applied.slice(-2)).toEqual(['commit_intent', 'applied'])

    const armed = armedTarget(window, h)
    world.probe.arm(window.stage, armed)
    await expect(world.s.svc.rollback(P1, ROOT_A, 'approval:k3-rollback')).rejects.toThrow(/in-process probe threw after/)
    const fired = world.probe.fired.at(-1)!
    expect(fired.stage).toBe(window.stage)
    expect(fired.target).toBe(armed)

    const interrupted = await ledgerLines(h)
    expect(kindsOf(interrupted)).toEqual([...applied, 'commit_intent'])
    const intent = interrupted.at(-1)!
    expect(intent).toMatchObject({ kind: 'commit_intent', intentId: `${P1}/rollback`, direction: 'rollback', approvalRef: 'approval:k3-rollback' })
    expect(intentFiles(intent).map(file => file.target)).toEqual(targets)
    expect(intentFiles(intent)[0]).toMatchObject({
      baselineSha256: sha256Of(world.candidateBody),
      contentSha256: world.production.identity.sha256,
      source: `sandbox/${P1}/champion/skills/${SKILL}/SKILL.md`,
    })
    expect(intentFiles(intent)[1]).toMatchObject({
      baselineSha256: sha256Of(world.derivedBytes),
      contentSha256: world.production.identity.contract!.sha256,
      source: `sandbox/${P1}/champion/skills/${SKILL}/${SKILL_SIDECAR_FILE}`,
    })
    const left = interruptedState(world, 'rollback', window)
    expect(await productionObject(h)).toEqual(left)
    expect(await stagedNow(h)).toEqual([])
    assertInterruptedState(world, 'rollback', window, left)

    await h.runtime.submitResult(ROOT_A, { summary: 'the first boot hands its checkout back' })
    const reopened = await boot({ workspace: directory })
    const h2 = reopened.h
    expect(await reopened.svc.openIntentTargets()).toEqual(targets)
    expect(await productionObject(h2)).toEqual(left)
    await expect(h2.root(ROOT_B, rootContract('ship the interrupted release', [ROW]))).rejects.toThrow(/commit-intent-open/)

    const adoptedStore = rootTaskStoreId(ROOT_A)
    await h2.task.createStore(adoptedStore)
    const warnings = captureWarnings(h2)
    const adoption = await h2.runtime.adoptRoot(adoptedStore, ROOT_A)
    expect(adoption.adopted).toBe(false)
    expect(warnings.filter(line => line.includes('could not be settled'))).toEqual([])

    await settledComplete({ reopened, direction: 'rollback', intent, walked: applied, target: sideState(world, 'production') })

    const root = await h2.root(ROOT_A, rootContract('ship the restored release'))
    const admitted = await admitChild(h2, ROOT_A, root)
    expect(await boundObject(await bindingOf(h2, root.storeId, admitted.childRunId))).toEqual(sideState(world, 'production'))
    await h2.runtime.submitResult(ROOT_A, { summary: 'the tree hands in the result its batch produced' })
  }, 180_000)

  it('stops by name when a third party rewrote one of the two files while the intent was open', async () => {
    const directory = await sharedDirectory()
    const world = await decidedWorld(directory)
    const h = world.s.h
    const targets = commitTargets(h)

    world.probe.arm('intent-recorded')
    await expect(world.s.svc.apply(P1, ROOT_A, 'approval:k3-apply')).rejects.toThrow(/in-process probe threw after/)
    expect(await productionObject(h)).toEqual(sideState(world, 'production'))
    const interrupted = await ledgerBytes(h)

    // A third party rewrites the sidecar — the file the intent names second, and
    // the one a naive recovery would happily replace.
    const thirdParty = serializeSkillSidecar({ ...(JSON.parse(world.production.sidecar!) as Record<string, unknown>), precondition: 'a third party rewrote the declaration' } as never)
    await writeFile(productionSidecar(h), thirdParty, 'utf8')

    const reopened = await boot({ workspace: directory })
    const h2 = reopened.h
    expect(await reopened.svc.openIntentTargets()).toEqual(targets)

    const adoptedStore = rootTaskStoreId(ROOT_A)
    await h2.task.createStore(adoptedStore)
    const warnings = captureWarnings(h2)
    expect((await h2.runtime.adoptRoot(adoptedStore, ROOT_A)).adopted).toBe(false)
    expect(warnings.join('\n')).toContain(`${P1}/apply`)
    expect(warnings.join('\n')).toContain('could not be settled')

    const outcomes = await reopened.svc.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ intentId: `${P1}/apply`, result: 'blocked', targets })
    expect(outcomes[0]!.detail).toMatch(/a third party changed it/)
    expect(outcomes[0]!.detail).toMatch(/the intent stays open/)
    // Nothing moved: the third party's bytes stand, the intent is still open, the
    // ledger is byte-identical, and admission still refuses the directory.
    expect(await productionObject(h2)).toEqual({ skillMd: world.production.skillMd, sidecar: thirdParty })
    expect(await ledgerBytes(h2)).toBe(interrupted)
    expect(await reopened.svc.openIntentTargets()).toEqual(targets)
    expect((await reopened.svc.get(P1)).openIntent?.intentId).toBe(`${P1}/apply`)
    expect((await reopened.svc.get(P1)).status).toBe('decided')
    await expect(h2.root(ROOT_B, rootContract('ship the tampered release', [ROW]))).rejects.toThrow(/commit-intent-open/)
    expect(await productionObject(h2)).toEqual({ skillMd: world.production.skillMd, sidecar: thirdParty })
  }, 180_000)

  it('refuses a second proposal the directory another proposal left open, and admits commits again once that intent is settled', async () => {
    const directory = await sharedDirectory()
    const world = await decidedWorld(directory)
    const h = world.s.h
    const targets = commitTargets(h)

    // A second proposal, prepared against the same production bytes and decided
    // while production still holds them — so its own baseline check cannot keep it
    // off a directory the first proposal's unfinished commit also names.
    const secondBody = skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt'], 'a second proposal version')
    await walkToGated(world.s, { proposalId: P2, content: secondBody })
    await decideThroughTool(world.s, P2)
    expect(await productionObject(h)).toEqual(sideState(world, 'production'))
    expect((await world.s.svc.get(P1)).prepared!.skillBaseline!.sha256).toBe(world.production.identity.sha256)
    expect((await world.s.svc.get(P2)).prepared!.skillBaseline!.sha256).toBe(world.production.identity.sha256)

    world.probe.arm('intent-recorded')
    await expect(world.s.svc.apply(P1, ROOT_A, 'approval:k3-apply')).rejects.toThrow(/in-process probe threw after/)
    const interrupted = await ledgerBytes(h)
    expect(await world.s.svc.openIntentTargets()).toEqual(targets)

    // The second proposal is refused by name before it can move either file: the
    // gate matches the production *directory*, because one intent covers the whole
    // fixed file set.
    const refused = await world.s.call('evolution_apply', { proposalId: P2 })
    expect(refused.text).toContain('evolution_apply rejected:')
    expect(refused.text).toContain(productionDirectory(h))
    expect(refused.text).toContain(`${P1}/apply`)
    expect(refused.text).toContain("another proposal's unsettled intent")
    expect(refused.text).toContain('nothing was written and no commit intent was recorded')
    expect(await ledgerBytes(h)).toBe(interrupted)
    expect(await productionObject(h)).toEqual(sideState(world, 'production'))
    expect(await stagedNow(h)).toEqual([])
    expect((await world.s.svc.get(P2)).openIntent).toBeUndefined()

    // The host settles the first intent, and the directory takes commits again.
    const outcomes = await world.s.svc.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ intentId: `${P1}/apply`, result: 'completed-redone', targets })
    expect(await productionObject(h)).toEqual(sideState(world, 'candidate'))

    // The stale second proposal is refused by the pre-existing baseline rule —
    // production no longer holds what it was prepared against.
    const stale = await world.s.call('evolution_apply', { proposalId: P2 })
    expect(stale.text).toContain('changed since prepare')
    // …and a proposal prepared against the recovered production commits both files.
    // Its own target failure is `t-tail`, which the version production now holds
    // still does not answer — so a legal commit really is one.
    const thirdBody = skillBody(SKILL, ['fix.txt', 'keep.txt', 'holdout.txt', 'tail.txt'])
    await walkToGated(world.s, { proposalId: 'k3-p3', content: thirdBody, samples: ['t-tail'], holdout: ['t-holdout'] })
    await decideThroughTool(world.s, 'k3-p3')
    await applyThroughTool(world.s, 'k3-p3')
    expect(await productionObject(h)).toEqual({
      skillMd: thirdBody,
      sidecar: serializeSkillSidecar(derivedSidecar(JSON.parse(world.derivedBytes), sha256Of(thirdBody)) as never),
    })
    const landed = await ledgerLines(h)
    expect(intentFiles(landed.filter(line => line.kind === 'commit_intent').at(-1)!).map(file => file.target)).toEqual(targets)
    expect(await world.s.svc.openIntentTargets()).toEqual([])
  }, 240_000)
})

/* ------------------------------------------------------------------------- *
 * K3-4 — the directory a rollback writes
 * ------------------------------------------------------------------------- */

/**
 * The declaration a third party drops beside a guidance object: a *valid*
 * execution declaration (the row grants it, the registered `command` verifier
 * judges it, it declares no resource) whose `content.skillMdSha256` is the digest
 * of the body a rollback *will* restore. So on an unfixed path the rollback's
 * whole-object check reads a valid verdict whose role is not the one the intent
 * commits — and the write has already happened by then.
 */
function executionDriftDeclaration(championSha256: string): Record<string, unknown> {
  return {
    contractVersion: 1,
    type: 'execution',
    capabilities: [GUIDE_ROW],
    precondition: 'a third party declared an execution provider while the object was applied',
    inputs: [],
    outputs: [],
    requiredTools: [],
    verifier: { ref: 'command' },
    content: { skillMdSha256: championSha256, resources: [] },
  }
}

/**
 * The two shapes a third party leaves in the directory a guidance rollback would
 * write: an execution declaration beside the object (a role drift, which an
 * unfixed path only reports *after* the `SKILL.md` has been replaced) and a file
 * at a supported resource position (which an unfixed path does not report at all
 * — the guidance verdict tolerates it, the rollback succeeds, and the undeclared
 * resource stays where it was).
 */
const DIRECTORY_DRIFT: readonly {
  readonly label: string
  /** The entry the refusal has to name. */
  readonly entry: string
  add(h: RunStack, championSha256: string): Promise<void>
}[] = [
  {
    label: 'an execution declaration beside the guidance object',
    entry: SKILL_SIDECAR_FILE,
    add: async (h, championSha256) => {
      await writeFile(productionSidecar(h, CLEAN_SKILL), serializeSkillSidecar(executionDriftDeclaration(championSha256) as never), 'utf8')
    },
  },
  {
    label: 'a file at a supported resource position',
    entry: 'references/notes.md',
    add: async h => {
      await mkdir(join(productionDirectory(h, CLEAN_SKILL), 'references'), { recursive: true })
      await writeFile(join(productionDirectory(h, CLEAN_SKILL), 'references', 'notes.md'), 'a reference the object never declared\n', 'utf8')
    },
  },
]

/**
 * The world both cases below start from: one guidance object in production, one
 * proposal walked to `applied` through the real tools, and production holding the
 * candidate body — `guidance.skillMd` is the champion body a rollback restores.
 */
async function appliedGuidanceWorld(options: { commitProbe?: (stage: CommitStage, target?: string) => void } = {}): Promise<{
  s: UnitStack
  guidance: InstalledSkill
  candidateBody: string
}> {
  const s = await boot({ ...options })
  const h = s.h
  const guidance = await writeSkillObject(join(h.home, 'skills'), { name: CLEAN_SKILL, body: skillBody(CLEAN_SKILL, ['keep.txt', 'holdout.txt']) })
  const root = await h.root(ROOT_A, rootContract('evaluate the candidate guidance skill'))
  await writeSample(h, root.storeId, { taskId: 't-fix', runId: 'r-fix-history', objective: 'the answer file is produced', acceptance: criterion('ac-fix', 'test -f fix.txt'), outcome: 'failed', capability: GUIDE_ROW })
  await writeSample(h, root.storeId, { taskId: 't-holdout', runId: 'r-holdout-history', objective: 'the held-out answer file is produced', acceptance: criterion('ac-holdout', 'test -f holdout.txt'), outcome: 'verified', capability: GUIDE_ROW })
  await mkdir(join(h.checkout, 'nested'), { recursive: true })
  const candidateBody = skillBody(CLEAN_SKILL, ['fix.txt', 'holdout.txt'])
  await walkToGated(s, { proposalId: P2, name: CLEAN_SKILL, content: candidateBody, samples: ['t-fix'], holdout: ['t-holdout'] })
  await decideThroughTool(s, P2)
  await applyThroughTool(s, P2)
  return { s, guidance, candidateBody }
}

describe('K3-4: a rollback refuses a directory holding entries the committed object does not name, before anything is written', () => {
  it.each(DIRECTORY_DRIFT)('refuses a fresh rollback of a directory that now holds $label, writing nothing', async ({ entry, add }) => {
    const { s, guidance, candidateBody } = await appliedGuidanceWorld()
    const h = s.h
    const target = productionSkill(h, CLEAN_SKILL)
    // The apply landed, whole: one guidance file, no declaration beside it.
    expect(await productionObject(h, CLEAN_SKILL)).toEqual({ skillMd: candidateBody })

    // A third party adds an entry the object the apply installed does not name —
    // after the apply, so nothing that ran before this write saw it.
    await add(h, guidance.skillMdSha256)

    const before = await ledgerBytes(h)
    const productionBefore = await productionObject(h, CLEAN_SKILL)
    const driftedPath = join(productionDirectory(h, CLEAN_SKILL), entry)
    const driftedBytes = await readFile(driftedPath, 'utf8')
    const refused = await s.svc.rollback(P2, ROOT_A, 'approval:k3-rollback')
      .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)))

    // The refusal names the entry and happens *before* the write: nothing was
    // written, no second intent was recorded, and the proposal is still applied.
    // The message carries what production and the ledger hold instead, so a
    // refusal that arrived after the write cannot read as a pass.
    const afterRefusal = await productionObject(h, CLEAN_SKILL)
    expect(
      refused,
      `the rollback must refuse before it writes anything — production now holds ${JSON.stringify(afterRefusal)} and the ledger ends with ` +
      `${JSON.stringify(kindsOf(await ledgerLines(h)).slice(-2))}`,
    ).toContain(entry)
    expect(refused).toContain('nothing was written')
    expect(await ledgerBytes(h)).toBe(before)
    expect(kindsOf(await ledgerLines(h)).filter(kind => kind === 'commit_intent')).toHaveLength(1)
    expect(await productionObject(h, CLEAN_SKILL)).toEqual(productionBefore)
    // The entry the refusal is about — a file the object does not name, so not
    // one the object identity above covers — stands exactly as it was left.
    expect(await readFile(driftedPath, 'utf8')).toBe(driftedBytes)
    expect(await stagingFiles(productionDirectory(h, CLEAN_SKILL))).toEqual([])
    expect(await s.svc.openIntentTargets()).toEqual([])
    expect((await s.svc.get(P2)).status).toBe('applied')
    expect(await readFile(target, 'utf8')).toBe(candidateBody)
  }, 180_000)

  it('refuses the retry of an interrupted rollback and reports the directory blocked, returning production and the ledger unchanged', async () => {
    const probe = windowProbe()
    const { s, guidance, candidateBody } = await appliedGuidanceWorld({ commitProbe: probe.probe })
    const h = s.h
    const target = productionSkill(h, CLEAN_SKILL)

    // The rollback is interrupted right after its intent line: the intent is open
    // and production still holds exactly what the apply installed.
    probe.arm('intent-recorded')
    await expect(s.svc.rollback(P2, ROOT_A, 'approval:k3-rollback')).rejects.toThrow(/in-process probe threw after/)
    const interrupted = await ledgerBytes(h)
    expect(await productionObject(h, CLEAN_SKILL)).toEqual({ skillMd: candidateBody })
    expect(await s.svc.openIntentTargets()).toEqual([target])
    expect((await s.svc.get(P2)).openIntent?.intentId).toBe(`${P2}/rollback`)

    // The third party's entry arrives while the intent is open.
    await writeFile(productionSidecar(h, CLEAN_SKILL), serializeSkillSidecar(executionDriftDeclaration(guidance.skillMdSha256) as never), 'utf8')
    const drifted = await productionObject(h, CLEAN_SKILL)

    // The retry settles the open intent, and the settlement refuses by name
    // before it writes: the recovery entry is a blocked outcome, not a write.
    const retry = await s.svc.rollback(P2, ROOT_A, 'approval:k3-rollback')
      .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    const afterRetry = await productionObject(h, CLEAN_SKILL)
    expect(
      retry,
      `the retry must refuse the directory, not write it — production now holds ${JSON.stringify(afterRetry)}`,
    ).toContain(SKILL_SIDECAR_FILE)
    expect(retry).toContain('the intent stays open')
    expect(retry).toContain('nothing is written')

    const outcomes = await s.svc.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ intentId: `${P2}/rollback`, result: 'blocked', targets: [target] })
    expect(outcomes[0]!.detail).toContain(SKILL_SIDECAR_FILE)
    expect(outcomes[0]!.detail).toContain('the intent stays open')
    expect(outcomes[0]!.detail).toContain('nothing is written')

    // Neither attempt moved a byte: the third party's entry stands, the ledger is
    // byte-identical, the intent is still open and the proposal still applied.
    expect(await productionObject(h, CLEAN_SKILL)).toEqual(drifted)
    expect(await ledgerBytes(h)).toBe(interrupted)
    expect(await stagingFiles(productionDirectory(h, CLEAN_SKILL))).toEqual([])
    expect(await s.svc.openIntentTargets()).toEqual([target])
    expect((await s.svc.get(P2)).status).toBe('applied')
  }, 180_000)
})

/* ------------------------------------------------------------------------- *
 * K3-4 — the directory a two-file commit writes
 * ------------------------------------------------------------------------- */

/**
 * The entries a third party leaves in the directory an **execution** commit would
 * write. An execution object's declaration names every file it covers, so its
 * committed file set has to name every file in that directory back, and all three
 * shapes below are refused by the file set that does not name them: a file at a
 * supported resource position the declaration never listed, an entry the
 * supported vocabulary does not cover at all, and a staging file whose prefix
 * belongs to no target of this object. The last one is deliberate rather than an
 * oversight: `.SKILL.md.tmp-…` is *this* target's leftover and passes (a killed
 * attempt leaves one, and a recovery sweeps it), while `.other.md.tmp-…` could
 * only come from a target that is not in this file set — and the whole-object
 * verification after the write refuses such an entry too, so accepting it here
 * would only move the same refusal past the write.
 *
 * `named` is the fragment the refusal has to carry. The check reads the skill
 * directory's own entries, so the resource shape is named as the entry it is — the
 * `references/` directory, with the trailing slash a directory entry gets — and
 * not as the file inside it.
 */
const EXECUTION_DIRECTORY_DRIFT: readonly {
  readonly label: string
  readonly entry: string
  readonly named: string
  readonly note: string
}[] = [
  {
    label: 'a file at a supported resource position the declaration never listed',
    entry: 'references/notes.md',
    named: 'references/',
    note: 'a resource position, outside the two files the object declares',
  },
  {
    label: 'an entry the supported vocabulary does not cover',
    entry: 'helper.sh',
    named: 'helper.sh',
    note: 'a direct entry of the skill directory that is not SKILL.md, the sidecar or a resource directory',
  },
  {
    label: 'a staging file of a target this object does not have',
    entry: '.other.md.tmp-4242-deadbeef',
    named: '.other.md.tmp-4242-deadbeef',
    note: 'this object has no "other.md", so its prefix is nobody\'s leftover — the post-write verification refuses it too',
  },
]

/** Write one externally added entry under the skill directory of a two-file world. */
async function addExecutionEntry(h: RunStack, entry: string): Promise<void> {
  const at = join(productionDirectory(h), entry)
  await mkdir(dirname(at), { recursive: true })
  await writeFile(at, `${entry} was added from outside this ledger\n`, 'utf8')
}

describe('K3-4: a two-file commit refuses a production directory holding entries the execution object does not name, before anything is written', () => {
  it.each(EXECUTION_DIRECTORY_DRIFT)('refuses the apply when the directory holds $label, writing nothing', async ({ entry, named, note }) => {
    const world = await decidedWorld(await sharedDirectory())
    const h = world.s.h
    const targets = commitTargets(h)
    const production = sideState(world, 'production')
    expect(await productionObject(h)).toEqual(production)
    // Decided, with no commit of this direction recorded yet.
    expect(kindsOf(await ledgerLines(h)).slice(-2)).toEqual(['gated', 'decided'])
    expect(kindsOf(await ledgerLines(h)).filter(kind => kind === 'commit_intent')).toEqual([])

    // The third party's entry arrives after the decision, while production still
    // holds exactly what the proposal was prepared and decided against.
    await addExecutionEntry(h, entry)
    const entriesBefore = (await readdir(productionDirectory(h))).sort()

    const before = await ledgerBytes(h)
    const productionBefore = await productionObject(h)
    const refused = await world.s.svc.apply(P1, ROOT_A, 'approval:k3-apply')
      .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    const afterRefusal = await productionObject(h)
    expect(
      refused,
      `the apply must refuse before it writes anything (${note}) — production now holds ${JSON.stringify(afterRefusal)} and the ledger ` +
      `ends with ${JSON.stringify(kindsOf(await ledgerLines(h)).slice(-2))}`,
    ).toContain(named)
    expect(refused).toContain('nothing was written')

    // Nothing moved: no intent line was recorded, both production files are the
    // bytes they were, the directory holds exactly the entries it held (the
    // stranger's file included — a refusal removes nothing), and the proposal is
    // still decided.
    expect(await ledgerBytes(h)).toBe(before)
    expect(kindsOf(await ledgerLines(h)).filter(kind => kind === 'commit_intent')).toEqual([])
    expect(await productionObject(h)).toEqual(productionBefore)
    expect((await readdir(productionDirectory(h))).sort()).toEqual(entriesBefore)
    expect(await world.s.svc.openIntentTargets()).toEqual([])
    expect((await world.s.svc.get(P1)).status).toBe('decided')
    // Both files of the object the proposal would have written are untouched.
    expect(await readFile(targets[0], 'utf8')).toBe(production.skillMd)
    expect(await readFile(targets[1], 'utf8')).toBe(production.sidecar)
  }, 180_000)

  it('refuses the rollback when the directory holds an entry the applied object does not name, writing nothing', async () => {
    const world = await decidedWorld(await sharedDirectory())
    const h = world.s.h
    const targets = commitTargets(h)
    // The world a rollback starts from: the apply that landed, whole.
    await world.s.svc.apply(P1, ROOT_A, 'approval:k3-apply')
    expect(await productionObject(h)).toEqual(sideState(world, 'candidate'))
    expect(kindsOf(await ledgerLines(h)).slice(-2)).toEqual(['commit_intent', 'applied'])

    await addExecutionEntry(h, 'references/notes.md')
    const entriesBefore = (await readdir(productionDirectory(h))).sort()

    const before = await ledgerBytes(h)
    const productionBefore = await productionObject(h)
    const refused = await world.s.svc.rollback(P1, ROOT_A, 'approval:k3-rollback')
      .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    const afterRefusal = await productionObject(h)
    expect(
      refused,
      `the rollback must refuse before it writes anything — production now holds ${JSON.stringify(afterRefusal)} and the ledger ends ` +
      `with ${JSON.stringify(kindsOf(await ledgerLines(h)).slice(-2))}`,
    ).toContain('references/')
    expect(refused).toContain('nothing was written')

    // The applied pair stands byte for byte, the directory still holds the
    // stranger's entry and nothing else changed, no rollback intent was recorded,
    // and the proposal is still applied.
    expect(await ledgerBytes(h)).toBe(before)
    expect(kindsOf(await ledgerLines(h)).filter(kind => kind === 'commit_intent')).toHaveLength(1)
    expect(await productionObject(h)).toEqual(productionBefore)
    expect((await readdir(productionDirectory(h))).sort()).toEqual(entriesBefore)
    expect(await readFile(join(productionDirectory(h), 'references', 'notes.md'), 'utf8')).toBe('references/notes.md was added from outside this ledger\n')
    expect(await world.s.svc.openIntentTargets()).toEqual([])
    expect((await world.s.svc.get(P1)).status).toBe('applied')
    expect(await readFile(targets[1], 'utf8')).toBe(world.derivedBytes)
  }, 180_000)

  it('lets the commit through when the only other entry is this object\u2019s own staging leftover, and sweeps it', async () => {
    const world = await decidedWorld(await sharedDirectory())
    const h = world.s.h
    const stale = join(productionDirectory(h), '.SKILL.md.tmp-4242-deadbeef')
    await writeFile(stale, '# a staging file a killed attempt of this very target left behind\n', 'utf8')

    await world.s.svc.apply(P1, ROOT_A, 'approval:k3-apply')

    // The leftover is this object's own, so it is not a foreign entry: the commit
    // runs and the sweep removes it — the tolerated shape and the refused one are
    // one character apart, which is what the cases above pin from the other side.
    expect(existsSync(stale)).toBe(false)
    expect(await productionObject(h)).toEqual(sideState(world, 'candidate'))
    expect(await stagedNow(h)).toEqual([])
    expect(kindsOf(await ledgerLines(h)).slice(-2)).toEqual(['commit_intent', 'applied'])
    expect((await world.s.svc.get(P1)).status).toBe('applied')
  }, 180_000)
})

/* ------------------------------------------------------------------------- *
 * K3-4 — the real process exit
 * ------------------------------------------------------------------------- */

/** The nine tools this build registers; K3-5 asserts the chain really went through all of them. */
const EVOLUTION_TOOLS = [
  'evolution_propose',
  'evolution_candidate',
  'evolution_prepare',
  'evolution_replay',
  'evolution_gate',
  'evolution_decide',
  'evolution_apply',
  'evolution_rollback',
  'evolution_list',
] as const

/** The windows the parent kills a nested process image at: three of the apply's, and the mixed one of the rollback's. */
const EXIT_CASES: readonly { direction: CommitDirection; window: CommitWindow }[] = [
  { direction: 'apply', window: APPLY_WINDOWS[0]! },
  { direction: 'apply', window: APPLY_WINDOWS[1]! },
  { direction: 'apply', window: APPLY_WINDOWS[2]! },
  { direction: 'rollback', window: ROLLBACK_WINDOWS[1]! },
]

/**
 * The killed half. The subject is a real process image: the nested run boots this
 * very stack over the parent's directory, builds the same service, and its probe
 * answers the armed window with `process.kill(process.pid, 'SIGKILL')` — no
 * `catch`, no `finally`, nothing cleaned up. That is what a killed deployment
 * leaves, and only a *second* process image settling it proves the recovery.
 *
 * A plain throw cannot stand in for it ({@link windowProbe} is the other, cheaper
 * seam) and the assertions keep the two apart: this case checks the signal, the
 * dead pid and the disk state a death leaves, where the throw cases check what an
 * unwind leaves.
 */
describe.skipIf(EXIT_WINDOW !== undefined)('K3-4 (real exit): the process that commits is killed, and the host that reopens the directory settles it', () => {
  it.each(EXIT_CASES)('settles a $direction killed after $window.label, redoing or completing it', async ({ direction, window }) => {
    const directory = await sharedDirectory()
    const world = await decidedWorld(directory)
    const h = world.s.h
    const targets = commitTargets(h)
    // The world a rollback starts from: the apply that landed, whole, by this
    // ledger — nothing interrupted, nothing killed.
    if (direction === 'rollback') {
      await world.s.svc.apply(P1, ROOT_A, 'approval:k3-apply')
      expect(await productionObject(h)).toEqual(sideState(world, 'candidate'))
    }
    const walked = kindsOf(await ledgerLines(h))
    expect(walked.slice(-(direction === 'rollback' ? 2 : 1))).toEqual(direction === 'rollback' ? ['commit_intent', 'applied'] : ['decided'])

    // A process image of its own performs the commit and is killed inside it. The
    // session plane the child cannot mint for itself travels with the workspace,
    // as the logs a deployment's next process would simply open.
    await handOverSessions(h, directory)
    const child = await forcedExit(directory, spawnCommitChild(window.stage, direction, window.file, directory))
    expect(child.window).toBe(window.stage)
    expect(child.direction).toBe(direction)
    expect(child.file).toBe(window.file)

    // What the death left, read straight off the ledger and both production files:
    // the intent of this very commit, no completion, and one of the two complete
    // versions — or, in the mixed window, the new `SKILL.md` beside the old sidecar.
    const interrupted = await ledgerLines(h)
    expect(kindsOf(interrupted)).toEqual([...walked, 'commit_intent'])
    const intent = interrupted.at(-1)!
    expect(intent).toMatchObject({
      kind: 'commit_intent',
      intentId: `${P1}/${direction}`,
      proposalId: P1,
      direction,
      approvalRef: direction === 'apply' ? 'approval:k3-apply' : 'approval:k3-rollback',
    })
    expect(intentFiles(intent).map(file => file.target)).toEqual(targets)
    const left = interruptedState(world, direction, window)
    expect(await productionObject(h)).toEqual(left)
    assertInterruptedState(world, direction, window, left)
    // No staging file survives these windows: the temp of a file that was renamed
    // is gone with the rename, and the window before the first stage never wrote one.
    expect(await stagedNow(h)).toEqual([])

    // The reopen: a second process image over the same directory. The open intent
    // is what it sees, and the directory it names is refused before any recovery ran.
    await h.runtime.submitResult(ROOT_A, { summary: 'the first boot hands its checkout back' })
    const reopened = await boot({ workspace: directory })
    const h2 = reopened.h
    expect(await reopened.svc.openIntentTargets()).toEqual(targets)
    expect(await productionObject(h2)).toEqual(left)
    await expect(h2.root(ROOT_B, rootContract('ship the killed release', [ROW]))).rejects.toThrow(/commit-intent-open/)
    expect(await reopened.svc.openIntentTargets()).toEqual(targets)

    // The host's own recovery entry, and the settlement it must reach: the whole
    // object at the version this direction committed.
    const adoptedStore = rootTaskStoreId(ROOT_A)
    await h2.task.createStore(adoptedStore)
    const warnings = captureWarnings(h2)
    expect((await h2.runtime.adoptRoot(adoptedStore, ROOT_A)).adopted).toBe(false)
    expect(warnings.filter(line => line.includes('could not be settled'))).toEqual([])
    await settledComplete({ reopened, direction, intent, walked, target: settledState(world, direction) })

    // A run admitted after the recovery loads the complete object that direction left.
    const root = await h2.root(ROOT_A, rootContract('ship the recovered release'))
    const admitted = await admitChild(h2, ROOT_A, root)
    expect(await boundObject(await bindingOf(h2, root.storeId, admitted.childRunId))).toEqual(settledState(world, direction))
    await h2.runtime.submitResult(ROOT_A, { summary: 'the tree hands in the result its batch produced' })
  }, 240_000)
})

/**
 * The one case a nested run executes. It exists only under the env
 * {@link spawnCommitChild} sets: without it the whole describe — and with it the
 * only `process.kill` in this file — is skipped, so an ordinary suite can never
 * kill a process, whatever it runs.
 */
describe.skipIf(EXIT_WINDOW === undefined)('K3-4 (nested child): the process image that dies inside a two-file commit', () => {
  it(CHILD_CASE, async () => {
    const window = EXIT_WINDOW!
    const workspace = EXIT_WORKSPACE
    if (workspace === undefined) throw new Error('the child case runs only under the env its parent sets: K3_REAL_EXIT_WORKSPACE is missing')

    // A process image of its own over the parent's directory: it reads the decided
    // proposal and both production files off disk, and its probe exits the process
    // at the armed window — the stage, and the file of the object — by SIGKILL.
    let stack!: UnitStack
    const armed = (): string => (EXIT_FILE === 'sidecar' ? productionSidecar(stack.h) : productionSkill(stack.h))
    const probed = await boot({
      workspace,
      quiet: true,
      commitProbe: (stage, target) => {
        if (stage !== window) return
        if ((stage === 'write-staged' || stage === 'write-renamed') && target !== armed()) return
        process.kill(process.pid, 'SIGKILL')
      },
    })
    stack = probed
    // The session plane the parent handed over, replayed into this boot's memory
    // before anything re-reads it: the apply re-checks the promotion against the
    // store and the side runs' own logs (S4-E §Q3).
    await replaySessionLogs(stack.h, await readFile(join(workspace, SESSION_HANDOVER), 'utf8'))
    // Written before the commit: this pid is the parent's proof of which process
    // image performed it. Everything below the call is dead code.
    await writeFile(
      join(workspace, EXIT_MARKER),
      `${JSON.stringify({ window, direction: EXIT_DIRECTION, file: EXIT_FILE, pid: process.pid }, null, 2)}\n`,
      'utf8',
    )
    if (EXIT_DIRECTION === 'rollback') await stack.svc.rollback(P1, ROOT_A, 'approval:k3-rollback')
    else await stack.svc.apply(P1, ROOT_A, 'approval:k3-apply')
  }, 240_000)
})

/* ------------------------------------------------------------------------- *
 * K3-5 — the current format, the whole-object rollback, and the nine tools
 * ------------------------------------------------------------------------- */

describe('K3-5: the current ledger format reads back, and the whole object rolls back through the tools', () => {
  it('reopens the formatVersion 4 ledger, rolls both files back, and drives all nine tools on the execution object', async () => {
    const directory = await sharedDirectory()
    const world = await decidedWorld(directory)
    const h = world.s.h
    await applyThroughTool(world.s, P1)
    expect(await productionObject(h)).toEqual(sideState(world, 'candidate'))
    expect(kindsOf(await ledgerLines(h)).slice(-2)).toEqual(['commit_intent', 'applied'])

    // The reopen: a new process image over the same directory. Every line it reads
    // is the one format this build writes, and the proposal is applied with nothing open.
    await h.runtime.submitResult(ROOT_A, { summary: 'the first boot hands its checkout back' })
    const reopened = await boot({ workspace: directory })
    const h2 = reopened.h
    const lines = await ledgerLines(h2)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every(line => line.formatVersion === 4)).toBe(true)
    expect((await reopened.svc.get(P1)).status).toBe('applied')
    expect((await reopened.svc.get(P1)).openIntent).toBeUndefined()
    expect(await reopened.svc.openIntentTargets()).toEqual([])
    expect(await productionObject(h2)).toEqual(sideState(world, 'candidate'))

    // The read tool on the reopened process's own surface: the applied proposal is
    // listed, and the query writes nothing.
    const beforeList = await ledgerBytes(h2)
    const listed = await reopened.call('evolution_list', {})
    expect(listed.isError, listed.text).toBe(false)
    expect(listed.text).toContain(P1)
    expect(await ledgerBytes(h2)).toBe(beforeList)

    // The rollback: the champion snapshot restored as one two-file commit.
    const rolledback = await reopened.call('evolution_rollback', { proposalId: P1 })
    expect(rolledback.isError, rolledback.text).toBe(false)
    expect(rolledback.text).toContain('champion restored')
    expect(await productionObject(h2)).toEqual(sideState(world, 'production'))
    const settled = await ledgerLines(h2)
    expect(kindsOf(settled).slice(-2)).toEqual(['commit_intent', 'rolledback'])
    const reverting = settled.filter(line => line.kind === 'commit_intent').at(-1)!
    expect(intentFiles(reverting).map(file => file.target)).toEqual(commitTargets(h2))
    expect(intentFiles(reverting)[0]).toMatchObject({
      baselineSha256: sha256Of(world.candidateBody),
      contentSha256: world.production.identity.sha256,
      source: `sandbox/${P1}/champion/skills/${SKILL}/SKILL.md`,
    })
    const completion = settled.at(-1)!
    expect(completion).toMatchObject({ targets: commitTargets(h2), intentId: `${P1}/rollback` })
    expect(completion.approvalRef).toBe(reverting.approvalRef)
    expect(settled.every(line => line.formatVersion === 4)).toBe(true)
    expect((await reopened.svc.get(P1)).status).toBe('rolledback')
    expect(await reopened.svc.openIntentTargets()).toEqual([])
    expect(await stagedNow(h2)).toEqual([])

    // A further rollback is the state machine's answer, not a second write.
    const afterRollback = await ledgerBytes(h2)
    const again = await reopened.call('evolution_rollback', { proposalId: P1 })
    expect(again.text).toContain('is rolledback; only an applied proposal can be rolled back')
    expect(await ledgerBytes(h2)).toBe(afterRollback)
    expect(kindsOf(await ledgerLines(h2)).slice(-2)).toEqual(['commit_intent', 'rolledback'])

    // The whole chain went through the nine tools themselves, each driven at least
    // once: no step of it is a service call the tools could not have made.
    const driven = new Set([...world.s.called, ...reopened.called])
    expect([...EVOLUTION_TOOLS].filter(name => !driven.has(name))).toEqual([])
  }, 240_000)
})

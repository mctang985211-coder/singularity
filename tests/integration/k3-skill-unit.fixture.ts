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

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { AcceptanceCriterion, RunProviderBinding } from '../../task/src/index.ts'
import { SKILL_SIDECAR_FILE, serializeSkillSidecar, skillContractDigest } from '../../task-runtime/src/index.ts'
import type { CapabilityConfig, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
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
import { disposeRunStacks, sha256Of, startRunStack, type RunStack } from '../support/run-stack.ts'

/** The capability row every case grants its skills through — one row, so the frozen provider list resolves the improved skill. */
export const ROW = 'k3-unit-row'

/** A second skill, used where a case must show one target is not another's. */
export const CLEAN_SKILL = 'k3-clean-fixture-skill'

/** Fixture names no deployment installs, so the machine running the suite cannot decide a verdict here. */
export const SKILL = 'k3-unit-fixture-skill'

export const ROOT_A = 's-k3-root-a' as SessionId

export const ROOT_B = 's-k3-root-b' as SessionId

export const ROOT_C = 's-k3-root-c' as SessionId

export const P1 = 'k3-p1'

export const P2 = 'k3-p2'

/** The answer files this spec's skill bodies name, and the criteria that judge them. */
export const ANSWER_FILES = ['fix.txt', 'keep.txt', 'holdout.txt', 'tail.txt'] as const

/** The file the scripted worker records the digest of the `SKILL.md` it actually loaded in. */
export const MARKER = 'k3-loaded-skill.sha256'

/** The second capability row: it grants the guidance skill the K3-2 positive case promotes. */
export const GUIDE_ROW = 'k3-guide-row'

/** The capability table both boots of a case admit against: one row per shape of object this spec improves. */
export const TABLE: Readonly<Record<string, CapabilityConfig>> = {
  [ROW]: { skills: [SKILL], tools: ['filesystem', 'bash'] },
  [GUIDE_ROW]: { skills: [CLEAN_SKILL], tools: ['filesystem'] },
}

/** The workspaces this spec minted: a caller-supplied workspace is the spec's to remove, not a stack's. */
export const workspaces: string[] = []

afterEach(async () => {
  await disposeRunStacks()
  for (const directory of workspaces.splice(0)) await rm(directory, { recursive: true, force: true })
})

/* ------------------------------------------------------------------------- *
 * The stack
 * ------------------------------------------------------------------------- */

/** One boot: the stack, the evolution plane over the shared ledger and skill roots, and the tools on the root's surface. */
export interface UnitStack {
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
export async function boot(
  options: {
    workspace?: string
    roots?: readonly SessionId[]
    capabilities?: Readonly<Record<string, CapabilityConfig>>
    /** Register the nine evolution tools on every root's own scope. */
    tools?: boolean
    /** Keep the scripted worker off (a case that never runs a worker). */
    quiet?: boolean
    commitProbe?: (stage: CommitStage, target?: string) => void
  } = {},
): Promise<UnitStack> {
  const roots = options.roots ?? [ROOT_A, ROOT_B, ROOT_C]
  let h!: RunStack
  h = await startRunStack({
    ...(options.workspace === undefined ? {} : { workspace: options.workspace }),
    roots: [...roots],
    capabilities: { ...(options.capabilities ?? TABLE) },
    tools: true,
    evolution: true,
    ...(options.quiet === true
      ? {}
      : { worker: (sessionId: SessionId, agent: Agent) => unitWorker(h, sessionId, agent) }),
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
export async function sharedDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'k3-unit-'))
  workspaces.push(directory)
  return directory
}

/* ------------------------------------------------------------------------- *
 * The skill object on disk
 * ------------------------------------------------------------------------- */

/** What one installed skill object is: the skill root, both files' bytes, and the content identity they add up to. */
export interface InstalledSkill {
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
export function skillBody(name: string, writes: readonly string[], description = `${name} fixture skill`): string {
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
export async function writeSkillObject(
  root: string,
  input: {
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
  },
): Promise<InstalledSkill> {
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
  const declared =
    input.sidecar === undefined
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
              resources: resources.map(resource => ({
                path: resource.path,
                sha256: resource.declaredSha256 ?? sha256Of(resource.bytes),
              })),
            },
          }
        : {
            contractVersion: 1,
            type: 'knowledge',
            source: 'this test fixture',
            scope: 'K3 unit fixture',
            content: {
              skillMdSha256: input.declaredSkillMdSha256 ?? skillMdSha256,
              resources: resources.map(resource => ({
                path: resource.path,
                sha256: resource.declaredSha256 ?? sha256Of(resource.bytes),
              })),
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
export async function loadedSkillFile(h: RunStack, agent: Agent, name = SKILL): Promise<string> {
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
export async function unitWorker(h: RunStack, sessionId: SessionId, agent: Agent): Promise<void> {
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
export function ledgerRoot(h: RunStack): string {
  return join(h.workspace, 'evolution')
}

/** One skill's production `SKILL.md`, and the declaration beside it when the object has one. */
export function productionSkill(h: RunStack, name: string = SKILL): string {
  return join(h.home, 'skills', name, 'SKILL.md')
}

export function productionSidecar(h: RunStack, name: string = SKILL): string {
  return join(h.home, 'skills', name, SKILL_SIDECAR_FILE)
}

export function productionDirectory(h: RunStack, name: string = SKILL): string {
  return join(h.home, 'skills', name)
}

/** The ledger's own lines, read from the file — never from a service's memory. */
export async function ledgerLines(h: RunStack): Promise<Record<string, unknown>[]> {
  const file = join(ledgerRoot(h), 'proposals.jsonl')
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf8')
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

/** The ledger file exactly as it stands, for the "this wrote nothing" assertions. */
export async function ledgerBytes(h: RunStack): Promise<string> {
  return readFile(join(ledgerRoot(h), 'proposals.jsonl'), 'utf8')
}

export function kindsOf(lines: readonly Record<string, unknown>[]): string[] {
  return lines.map(line => String(line.kind))
}

/** One file of a commit intent's own line: the target, both digests, and the recoverable source. */
export interface IntentFile {
  readonly target: string
  readonly baselineSha256: string
  readonly contentSha256: string
  readonly source: string
}

export function intentFiles(intent: Record<string, unknown>): IntentFile[] {
  const files = intent.files as IntentFile[] | undefined
  if (files === undefined) throw new Error(`the intent line names no files: ${JSON.stringify(intent)}`)
  return files
}

/** Every staging file left beside one production target (a settled commit removes its own, always). */
export async function stagingFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter(entry => entry.includes('.tmp-'))
}

/** The two production paths a two-file commit writes, in commit order. */
export function commitTargets(h: RunStack, name: string = SKILL): [string, string] {
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
export function rootContract(objective: string, capabilities: readonly string[] = []): RootContractSpec {
  return {
    objective,
    acceptanceCriteria: [{ criterionId: 'root-goal', description: `${objective} is delivered`, command: 'true' }],
    ...(capabilities.length === 0 ? {} : { requiredCapabilities: [...capabilities] }),
  }
}

export function child(objective: string, requiredCapabilities: readonly string[]): DecomposeSpec['children'][number] {
  return {
    objective,
    acceptanceCriteria: [{ description: `${objective} works`, command: 'true' }],
    requiredCapabilities: requiredCapabilities as string[],
  }
}

/** One admitted child run and the worker session it was given. */
export async function admitChild(
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
  return {
    childRunId,
    storeId: root.storeId,
    workerSessionId: (await h.task.runIn(root.storeId, childRunId)).sessionId as SessionId,
  }
}

/** One run's own binding, read from the store. */
export async function bindingOf(h: RunStack, storeId: string, runId: string): Promise<RunProviderBinding> {
  const binding = (await h.task.runIn(storeId, runId)).providerBinding
  if (binding === undefined) throw new Error(`run "${runId}" carries no provider binding`)
  if (binding.snapshotRoot === undefined) throw new Error(`run "${runId}" materialized no snapshot root`)
  return binding
}

/** One skill's two files as a run's own binding snapshot holds them — what that run really loaded. */
export async function boundObject(
  binding: RunProviderBinding,
  name: string = SKILL,
): Promise<{ skillMd: string; sidecar?: string }> {
  const root = binding.snapshotRoot!
  const skillMd = await readFile(join(root, name, 'SKILL.md'), 'utf8')
  const sidecarPath = join(root, name, SKILL_SIDECAR_FILE)
  return { skillMd, ...(existsSync(sidecarPath) ? { sidecar: await readFile(sidecarPath, 'utf8') } : {}) }
}

/**
 * The cordis logger's own warnings, as a deployment's log would show them — the
 * surface the host's recovery barrier reports a commit it could not settle on.
 */
export function captureWarnings(h: RunStack): string[] {
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
export function criterion(criterionId: string, command: string, verifierRef = 'command'): AcceptanceCriterion {
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
export async function writeSample(
  h: RunStack,
  storeId: string,
  input: {
    taskId: string
    runId: string
    objective: string
    acceptance: AcceptanceCriterion
    outcome: 'verified' | 'failed'
    capability?: string
  },
): Promise<void> {
  const capability = input.capability ?? ROW
  await h.task.createTaskIn(
    storeId,
    {
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
    },
    'tester',
  )
  await h.task.admitTaskIn(storeId, input.taskId, 'tester', { decompositionStatus: 'leaf' })
  await h.task.startRunIn(
    storeId,
    {
      runId: input.runId,
      taskId: input.taskId,
      sessionId: `s-${input.taskId}`,
      capabilitySnapshot: [SKILL, CLEAN_SKILL],
      artifacts: [],
      verifierResults: [],
      status: 'running',
      startedAt: new Date().toISOString(),
    },
    'tester',
  )
  await h.task.markRunStatusIn(storeId, input.taskId, input.runId, 'verifying', 'tester')
  await h.task.recordEvidenceIn(
    storeId,
    {
      evidenceId: `e-${input.runId}`,
      taskRunId: input.runId,
      taskId: input.taskId,
      artifacts: [],
      verifierResults: [
        {
          criterionId: input.acceptance.criterionId,
          status: input.outcome === 'verified' ? 'pass' : 'fail',
          verifierId: 'command',
        },
      ],
      claims: [],
      generatedAt: new Date().toISOString(),
    },
    'tester',
  )
  await h.task.markRunStatusIn(storeId, input.taskId, input.runId, input.outcome, 'tester', {
    ...(input.outcome === 'failed' ? { reason: 'the answer file was never produced' } : {}),
  })
  await h.task.recordReviewIn(
    storeId,
    {
      taskId: input.taskId,
      runId: input.runId,
      sessionId: `s-${input.taskId}`,
      outcome: input.outcome,
      evidenceRefs: [`e-${input.runId}`],
      anomalies: [`the historical run sample "${input.taskId}" locates`],
      ...(input.outcome === 'failed' ? { localizedCause: 'the answer file was never produced' } : {}),
      criteria: [
        {
          criterionId: input.acceptance.criterionId,
          verdict: input.outcome === 'verified' ? 'pass' : 'fail',
          verifierId: 'command',
        },
      ],
    },
    'tester',
  )
}

/**
 * The historical samples every case of this spec evaluates against: two observed
 * failures a candidate may be asked to fix (`t-fix`, which the body this spec
 * installs first never answers, and `t-tail`, which a *later* version of the same
 * skill still does not answer), a verified regression it must keep, and a
 * held-out case. All of them ask for the row that grants the skill under
 * improvement.
 */
export async function writeHistory(
  h: RunStack,
  storeId: string,
  capability = ROW,
  verifierRef = 'command',
): Promise<void> {
  await writeSample(h, storeId, {
    taskId: 't-fix',
    runId: 'r-fix-history',
    objective: 'the answer file is produced',
    acceptance: criterion('ac-fix', 'test -f fix.txt', verifierRef),
    outcome: 'failed',
    capability,
  })
  await writeSample(h, storeId, {
    taskId: 't-keep',
    runId: 'r-keep-history',
    objective: 'the kept answer file is produced',
    acceptance: criterion('ac-keep', 'test -f keep.txt', verifierRef),
    outcome: 'verified',
    capability,
  })
  await writeSample(h, storeId, {
    taskId: 't-holdout',
    runId: 'r-holdout-history',
    objective: 'the held-out answer file is produced',
    acceptance: criterion('ac-holdout', 'test -f holdout.txt', verifierRef),
    outcome: 'verified',
    capability,
  })
  await writeSample(h, storeId, {
    taskId: 't-tail',
    runId: 'r-tail-history',
    objective: 'the trailing answer file is produced',
    acceptance: criterion('ac-tail', 'test -f tail.txt', verifierRef),
    outcome: 'failed',
    capability,
  })
}

export const SAMPLES = ['t-fix', 't-keep'] as const

export const HOLDOUT = ['t-holdout'] as const

/* ------------------------------------------------------------------------- *
 * The real tool chain
 * ------------------------------------------------------------------------- */

export function gateAnswers(refs: readonly string[]) {
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
export async function walkToGated(
  s: UnitStack,
  input: {
    proposalId: string
    name?: string
    content: string
    actor?: SessionId
    samples?: readonly string[]
    holdout?: readonly string[]
  },
): Promise<{ reportPath: string; experimentId: string; report: ExperimentReport }> {
  const name = input.name ?? SKILL
  const actor = input.actor ?? ROOT_A
  const steps: [string, Record<string, unknown>][] = [
    [
      'evolution_propose',
      {
        proposalId: input.proposalId,
        level: 'L2',
        baseVersion: 'v1',
        targetType: 'skill',
        targetId: name,
        rationale: 'the fixture skill should carry the newer wording',
        sourceRefs: ['diagnosis:k3'],
      },
    ],
    [
      'evolution_candidate',
      {
        proposalId: input.proposalId,
        versionSet: { skill: 'v2' },
        mutationJson: JSON.stringify({ name, content: input.content }),
      },
    ],
    ['evolution_prepare', { proposalId: input.proposalId }],
    [
      'evolution_replay',
      {
        proposalId: input.proposalId,
        taskIds: [...(input.samples ?? SAMPLES)],
        holdoutTaskIds: [...(input.holdout ?? HOLDOUT)],
        budget: { note: 'the fixture declares no cost ceiling' },
      },
    ],
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
  const gated = await s.call(
    'evolution_gate',
    { proposalId: input.proposalId, ...gateAnswers([experiment.report]) },
    actor,
  )
  expect(gated.isError, gated.text).toBe(false)
  return { reportPath: experiment.report, experimentId: experiment.experimentId, report }
}

/** Close the human decision through the real tool: one real `approval.request`, then the `decided` line. */
export async function decideThroughTool(s: UnitStack, proposalId: string, actor: SessionId = ROOT_A): Promise<string> {
  const answer = await s.call('evolution_decide', { proposalId, decision: 'PROMOTE', note: 'the fix holds' }, actor)
  expect(answer.isError, answer.text).toBe(false)
  expect(answer.text).toContain('[decided] PROMOTE')
  expect(answer.text).toContain('nothing applied yet')
  return answer.text
}

/** Apply through the real tool: the second human gate, the two-file commit, and the applied record. */
export async function applyThroughTool(s: UnitStack, proposalId: string, actor: SessionId = ROOT_A): Promise<string> {
  const answer = await s.call('evolution_apply', { proposalId }, actor)
  expect(answer.isError, answer.text).toBe(false)
  expect(answer.text).toContain('[applied]')
  return answer.text
}

/**
 * The sidecar one candidate object's declaration should be: the production
 * object's own declaration with exactly `content.skillMdSha256` rewritten to the
 * candidate `SKILL.md` digest. Nothing else may move — not a capability, not a
 * required tool, not the verifier, not a resource.
 */
export function derivedSidecar(production: unknown, candidateSkillMdSha256: string): Record<string, unknown> {
  const declaration = structuredClone(production) as Record<string, unknown>
  declaration.content = { ...(declaration.content as Record<string, unknown>), skillMdSha256: candidateSkillMdSha256 }
  return declaration
}

/** The two production files as they stand, as a comparable pair. */
export async function productionObject(
  h: RunStack,
  name: string = SKILL,
): Promise<{ skillMd: string; sidecar?: string }> {
  const skillMd = await readFile(productionSkill(h, name), 'utf8')
  const sidecarPath = productionSidecar(h, name)
  return { skillMd, ...(existsSync(sidecarPath) ? { sidecar: await readFile(sidecarPath, 'utf8') } : {}) }
}

/**
 * The digest of a two-file production object, compared the way the intent records
 * it: the `SKILL.md` bytes on their own, and the declaration's canonical digest.
 */
export function objectIdentity(name: string, object: { skillMd: string; sidecar?: string }): SkillContentIdentity {
  return {
    name,
    sha256: sha256Of(object.skillMd),
    ...(object.sidecar === undefined
      ? {}
      : {
          contract: {
            sha256: sha256Of(object.sidecar),
            contractDigest: skillContractDigest(JSON.parse(object.sidecar) as never),
          },
        }),
  }
}

/* ------------------------------------------------------------------------- *
 * Interruptions
 * ------------------------------------------------------------------------- */

/** One fired probe: the durable stage, and the file it was reported for. */
export interface FiredStage {
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
export function windowProbe(): {
  probe: (stage: CommitStage, target?: string) => void
  arm: (stage: CommitStage, target?: string) => void
  fired: FiredStage[]
} {
  const fired: FiredStage[] = []
  let armed: FiredStage | undefined
  return {
    fired,
    arm: (stage, target) => {
      armed = { stage, ...(target === undefined ? {} : { target }) }
    },
    probe: (stage, target) => {
      fired.push({ stage, ...(target === undefined ? {} : { target }) })
      if (armed === undefined || stage !== armed.stage || (armed.target !== undefined && target !== armed.target))
        return
      armed = undefined
      throw new Error(`k3 fixture: the in-process probe threw after "${stage}" — a throw, not a process exit`)
    },
  }
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
export interface CommitWindow {
  readonly label: string
  readonly stage: CommitStage
  readonly file: 'skill' | 'sidecar'
  /** What production holds after the interruption: `old` for both files, `mixed` for the SKILL.md moved, `new` for both. */
  readonly interrupted: 'old' | 'mixed' | 'new'
  /** What a reconciliation settles it to. */
  readonly result: 'completed-redone' | 'completed-written'
}

export const APPLY_WINDOWS: readonly CommitWindow[] = [
  { label: 'intent-recorded', stage: 'intent-recorded', file: 'skill', interrupted: 'old', result: 'completed-redone' },
  {
    label: 'write-renamed @ SKILL.md',
    stage: 'write-renamed',
    file: 'skill',
    interrupted: 'mixed',
    result: 'completed-redone',
  },
  {
    label: 'write-renamed @ SKILL.contract.json',
    stage: 'write-renamed',
    file: 'sidecar',
    interrupted: 'new',
    result: 'completed-written',
  },
  {
    label: 'commit-verified',
    stage: 'commit-verified',
    file: 'skill',
    interrupted: 'new',
    result: 'completed-written',
  },
]

export const ROLLBACK_WINDOWS: readonly CommitWindow[] = [
  { label: 'intent-recorded', stage: 'intent-recorded', file: 'skill', interrupted: 'old', result: 'completed-redone' },
  {
    label: 'write-renamed @ SKILL.md',
    stage: 'write-renamed',
    file: 'skill',
    interrupted: 'mixed',
    result: 'completed-redone',
  },
  {
    label: 'write-renamed @ SKILL.contract.json',
    stage: 'write-renamed',
    file: 'sidecar',
    interrupted: 'new',
    result: 'completed-written',
  },
  {
    label: 'commit-verified',
    stage: 'commit-verified',
    file: 'skill',
    interrupted: 'new',
    result: 'completed-written',
  },
]

/* ------------------------------------------------------------------------- *
 * K3-4 — the two-file commit, interrupted and recovered
 * ------------------------------------------------------------------------- */

/** The world one commit window starts from, rebuilt here so the in-process and the killed cases assert the same thing. */
export interface DecidedWorld {
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
export async function decidedWorld(directory: string): Promise<DecidedWorld> {
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
    derivedBytes: serializeSkillSidecar(
      derivedSidecar(JSON.parse(production.sidecar!), sha256Of(candidateBody)) as never,
    ),
    root,
  }
}

/** One of the two complete versions a two-file commit moves between. */
export function sideState(
  world: DecidedWorld,
  which: 'production' | 'candidate',
): { skillMd: string; sidecar?: string } {
  return which === 'production'
    ? { skillMd: world.production.skillMd, sidecar: world.production.sidecar }
    : { skillMd: world.candidateBody, sidecar: world.derivedBytes }
}

/** What production holds in the middle of one interrupted window: the pre-commit state, the committed one, or the mixed pair. */
export function interruptedState(
  world: DecidedWorld,
  direction: CommitDirection,
  window: CommitWindow,
): { skillMd: string; sidecar?: string } {
  const from = direction === 'apply' ? 'production' : 'candidate'
  const to = direction === 'apply' ? 'candidate' : 'production'
  if (window.interrupted === 'old') return sideState(world, from)
  if (window.interrupted === 'new') return sideState(world, to)
  // The mixed state a death between the two renames leaves: the committed
  // `SKILL.md` beside the sidecar the commit had not replaced yet.
  return { skillMd: sideState(world, to).skillMd, sidecar: sideState(world, from).sidecar }
}

/** The candidate object's own content identity, as `prepare` recorded it for this world. */
export function candidateIdentity(world: DecidedWorld): SkillContentIdentity {
  return {
    name: SKILL,
    sha256: sha256Of(world.candidateBody),
    contract: {
      sha256: sha256Of(world.derivedBytes),
      contractDigest: skillContractDigest(JSON.parse(world.derivedBytes) as never),
    },
  }
}

/**
 * What the interruption left is one of the two complete versions — or, in the
 * mixed window, exactly the committed `SKILL.md` beside the sidecar that had not
 * been replaced yet. Neither complete object describes the mixed pair.
 */
export function assertInterruptedState(
  world: DecidedWorld,
  direction: CommitDirection,
  window: CommitWindow,
  held: { skillMd: string; sidecar?: string },
): void {
  const committed = direction === 'apply' ? candidateIdentity(world) : world.production.identity
  const previous = direction === 'apply' ? world.production.identity : candidateIdentity(world)
  const current = objectIdentity(SKILL, held)
  if (window.interrupted === 'mixed') {
    expect({ sha256: current.sha256, contract: current.contract!.sha256 }).toEqual({
      sha256: committed.sha256,
      contract: previous.contract!.sha256,
    })
    expect(current.contract!.sha256).not.toBe(committed.contract!.sha256)
    return
  }
  const expected = window.interrupted === 'old' ? previous : committed
  expect({ sha256: current.sha256, contract: current.contract!.sha256 }).toEqual({
    sha256: expected.sha256,
    contract: expected.contract!.sha256,
  })
}

/** The completion kind one direction records. */
export function completionKind(direction: CommitDirection): string {
  return direction === 'apply' ? 'applied' : 'rolledback'
}

/**
 * Everything a settled intent must show, read off disk: production is the
 * complete target version, the intent is closed by exactly one completion
 * carrying its own grant and both targets, nothing is left open, and a second
 * reconciliation is free.
 */
export async function settledComplete(input: {
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
export async function stagedNow(h: RunStack, name: string = SKILL): Promise<string[]> {
  return stagingFiles(productionDirectory(h, name))
}

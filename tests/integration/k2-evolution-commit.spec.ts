/**
 * K2 end to end on the real deployment wiring: a production write is one commit —
 * a durable intent, an atomic replace, a completion — and a process that dies
 * between two of those writes is settled by the host that reopens the same
 * directory.
 *
 * What is real: the real filesystem (the ledger file, the sandbox, the production
 * `SKILL.md`), the real `EvolutionService` with its fold, commit path and
 * reconciliation, the real `TaskRuntime` entries (`intakeRootContract`,
 * `decomposeAndRun`, `adoptRoot` and its recovery barrier), the real admission
 * pre-check over the real discovery roots, the real `AgentRuntime.spawn` with the
 * real skill plane, the real `TaskService` store, and the real evolution tools
 * where a case is about the tool layer.
 *
 * What is scripted, and why: the model loop (the stack's agent factory), and the
 * two ways a commit is interrupted. The two-sided experiment each candidate is
 * promoted from is the recorded-report fixture
 * (`tests/support/promotion-experiment.ts`); the real orchestration of that
 * experiment is proven in `tests/integration/evolution-replay-experiment.spec.ts`
 * and `tests/integration/experiment-runner.spec.ts`.
 *
 * **The two interruptions are different things, and this spec keeps them apart.**
 * {@link throwingProbe} is the *in-process* seam: it throws from the service's
 * typed `commitProbe` at one durable stage. That is a catchable exception — it
 * unwinds through this process's own `catch`/`finally` (so {@link writeFileAtomic}
 * removes the staging file it had written) and the process that threw keeps
 * running, with its service, its memory and its next call. The *real* exit is
 * {@link spawnCommitChild}: a nested run of this very spec, started over the same
 * directory, whose `commitProbe` calls `process.kill(process.pid, 'SIGKILL')` — no
 * `catch`, no `finally`, no cleanup, no next call, and the parent observes the
 * signal and a pid that is gone. Only the real exit can leave what a killed
 * deployment leaves (at `write-staged`, the staging file the dead writer had
 * fsynced beside the target), and only the real exit proves that a *second*
 * process image is what settles it. The throw cases are kept anyway: they are the
 * cheaper seam for the stages themselves, and the "a throw is not an exit" case
 * states the difference in assertions.
 *
 * **The reopen.** A second {@link startRunStack} over the *same* workspace is a
 * second process image: its own `Context`, its own services, its own store, its
 * own in-memory roots — reading the first one's ledger and production bytes off
 * disk and nothing else. The host entry that settles an interrupted commit is the
 * one a restart uses: `TaskRuntime.adoptRoot`'s recovery barrier, which
 * reconciles the evolution ledger before it takes a store over.
 *
 * Every assertion is read back from a durable surface — the bytes on disk, the
 * ledger's own lines (re-read from the file, never from a service's memory), the
 * store's snapshot and events, the skill a worker's own layer resolves, and the
 * refusal an admission or a tool actually produced.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { CapabilityConfig, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { EvolutionService, type CommitDirection } from '../../evolution/src/index.ts'
import type { CommitStage } from '../../evolution/src/commit.ts'
import { deploymentModelSelection } from '../../agent-singularity/src/index.ts'
import { defineEvolutionApplyTool } from '../../agent-singularity/src/tools/evolution-apply.ts'
import { defineEvolutionListTool } from '../../agent-singularity/src/tools/evolution-list.ts'
import { defineEvolutionRollbackTool } from '../../agent-singularity/src/tools/evolution-rollback.ts'
import { promotionExperimentContext, recordPromotionExperiment } from '../support/promotion-experiment.ts'
import {
  disposeRunStacks,
  exportSessionLogs,
  replaySessionLogs,
  sha256Of,
  skillText,
  startRunStack,
  writeGuidanceSkill,
  type RunStack,
} from '../support/run-stack.ts'

/** The capability the interrupted commit's target is granted through. */
const ROW = 'k2-commit-row'
/** A second skill, no commit of this ledger ever touches it. */
const CLEAN_ROW = 'k2-clean-row'
/** Fixture names no deployment installs, so the machine running the suite cannot decide a verdict here. */
const SKILL = 'k2-commit-fixture-skill'
const CLEAN_SKILL = 'k2-clean-fixture-skill'
const ROOT_A = 's-k2-root-a' as SessionId
const ROOT_B = 's-k2-root-b' as SessionId
const ROOT_C = 's-k2-root-c' as SessionId
const P1 = 'k2-p1'
const P2 = 'k2-p2'
const P3 = 'k2-p3'
/** A further proposal, on the second fixture skill: never the target two proposals compete for. */
const Q1 = 'k2-q1'
/** The three production versions this spec moves between; each is compared byte for byte. */
const V0 = 'K2 VERSION ZERO BODY'
const V1 = 'K2 VERSION ONE BODY'
const V2 = 'K2 VERSION TWO BODY'
/** The version a third party writes while a commit intent is open. */
const THIRD_PARTY = 'K2 A VERSION NO COMMIT OF THIS LEDGER WROTE'

/**
 * The env a nested child is started with: the one durable window it dies at, the
 * direction it commits in, and the workspace both processes share. A run that sets
 * none of them is a parent — the child case below is skipped and nothing here kills
 * anything; a run whose parent set all three *is* the child.
 */
const EXIT_WINDOW = process.env.K2_REAL_EXIT_WINDOW as CommitStage | undefined
const EXIT_DIRECTION = (process.env.K2_REAL_EXIT_DIRECTION ?? 'apply') as CommitDirection
const EXIT_WORKSPACE = process.env.K2_REAL_EXIT_WORKSPACE

/** The file a child writes its own pid into, before its commit — the parent's proof of which process image died. */
const EXIT_MARKER = 'k2-child-exit.json'

/**
 * The store {@link walkToDecided} records its experiment in — and the store `apply`
 * re-reads that evidence from (S4-E §Q3).
 */
const PROMOTION_STORE = 's-k2-promotion-fixture'

/**
 * The file the boot's own session logs travel in when a nested child has to
 * re-read them (see {@link handOverSessions}).
 */
const SESSION_HANDOVER = 'k2-child-sessions.json'

/** The one case a nested run is filtered to; no other case of this spec runs there. */
const CHILD_CASE = 'the child process dies by SIGKILL at its armed window'

/** The repo root a nested run starts from — the same `pnpm vitest` the outer run is, without the wrapper. */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** This spec's own file — the one file a nested run collects, where the outer run's file is. */
const SPEC_PATH = fileURLToPath(import.meta.url)

/** The capability table both boots of a case admit against. */
const TABLE: Readonly<Record<string, CapabilityConfig>> = {
  [ROW]: { skills: [SKILL], tools: ['filesystem'] },
  [CLEAN_ROW]: { skills: [CLEAN_SKILL], tools: ['filesystem'] },
}

/** The workspaces this spec minted: a caller-supplied workspace is the spec's to remove, not a stack's. */
const workspaces: string[] = []

afterEach(async () => {
  await disposeRunStacks()
  for (const directory of workspaces.splice(0)) await rm(directory, { recursive: true, force: true })
})

/**
 * One directory two boots share — the "same directory" a reopened process reads
 * its ledger and its production bytes from.
 */
async function sharedDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'k2-commit-'))
  workspaces.push(directory)
  return directory
}

/** The evolution ledger's directory inside one workspace (both boots resolve the same path). */
function ledgerRoot(h: RunStack): string {
  return join(h.workspace, 'evolution')
}

/** The one production path a skill commit writes, under the root the deployment's discovery also reads. */
function productionPath(h: RunStack, name: string = SKILL): string {
  return join(h.home, 'skills', name, 'SKILL.md')
}

/**
 * The production skill *directory* a commit's file set lives in — the unit the
 * per-target commit gate and the admission gate both match on (one intent covers
 * a skill's files together, so either file names the directory).
 */
function productionDirectory(h: RunStack, name: string = SKILL): string {
  return join(h.home, 'skills', name)
}

/** The evolution plane of one boot, over the shared ledger root and the production skill root. */
function evolutionOf(h: RunStack, commitProbe?: (stage: CommitStage, target?: string) => void): EvolutionService {
  return new EvolutionService(h.ctx, {
    root: ledgerRoot(h),
    skillRoot: join(h.home, 'skills'),
    // The deployment's own selection: the experiment freezes it and the promotion
    // gate re-reads the runs' own requests against it.
    modelSelection: () => deploymentModelSelection(h.ctx),
    ...(commitProbe === undefined ? {} : { commitProbe }),
  })
}

/**
 * The in-process seam, and nothing more than that: `arm` names the one durable
 * stage the probe throws at, so the intent stays open and no later stage of that
 * commit runs. A `write-*` stage fires once per file of the object and carries
 * that file's target; the guidance objects this spec commits are one file, so
 * one firing each. The throw is *not* a process exit: it unwinds through this
 * process's own stack, `writeFileAtomic`'s `catch` removes the staging file it
 * had written, and the instance that threw is still there to be used again — see
 * the "a throw is not an exit" case below. The real exit is the other thing:
 * {@link spawnCommitChild} kills a nested process image with SIGKILL and
 * {@link forcedExit} asserts that signal, the dead pid and what only a real death
 * can leave on disk.
 */
function throwingProbe(): { probe: (stage: CommitStage, target?: string) => void; arm: (stage: CommitStage) => void; stages: CommitStage[] } {
  const stages: CommitStage[] = []
  let armed: CommitStage | undefined
  return {
    stages,
    arm: stage => { armed = stage },
    probe: (stage, _target) => {
      stages.push(stage)
      if (stage !== armed) return
      armed = undefined
      throw new Error(`k2 fixture: the in-process probe threw after "${stage}" — a throw, not a process exit`)
    },
  }
}

/**
 * The real forced exit: a nested run of this very spec, told by env which window to
 * die at. Nothing in that run is scripted beyond the exit itself — it boots the same
 * stack over the same directory, builds the same service and calls the same
 * `apply`/`rollback` — and its probe answers the armed window with
 * `process.kill(process.pid, 'SIGKILL')`, so the process image the commit runs in
 * ends between two durable writes the way a killed deployment does: no `catch`, no
 * `finally`, no cleanup of the stage it died in. `--pool=threads` is what makes the
 * signal the parent observes the case body's own: the body then runs in the process
 * `spawnSync` started, not in a worker beside it, and `-t` keeps every other case of
 * this spec — this spawner included — out of the nested run. The timeout bounds a
 * child that hangs, so the outer case fails loudly instead of stalling.
 */
function spawnCommitChild(window: CommitStage, direction: CommitDirection, workspace: string): SpawnSyncReturns<string> {
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
    timeout: 120_000,
    env: {
      ...process.env,
      K2_REAL_EXIT_WINDOW: window,
      K2_REAL_EXIT_DIRECTION: direction,
      K2_REAL_EXIT_WORKSPACE: workspace,
    },
  })
}

/** What the parent proves about the child process image that performed the commit. */
interface ForcedExit {
  /** The window the child was told to die at, as the child itself recorded it. */
  readonly window: CommitStage
  /** The direction the child committed in. */
  readonly direction: CommitDirection
  /** The child's own pid — the process image the commit ran in, and the one that is gone. */
  readonly pid: number
}

/**
 * The forced exit itself, asserted before anything about the durable state: the
 * nested run answered a *signal* (so there is no exit code and no normal unwind),
 * the marker it wrote before its commit names the pid `spawnSync` started and not
 * this process's, and that pid is dead. Nothing about {@link throwingProbe} looks
 * like this — a throw is caught by this live process, its `finally` blocks run, and
 * the instance that threw can be used again.
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

/** What the null probe to a pid answered: `undefined` when it exists, `ESRCH` when it is gone. */
function pidProbe(pid: number): string | undefined {
  try {
    process.kill(pid, 0)
    return undefined
  } catch (error) {
    return (error as NodeJS.ErrnoException).code
  }
}

/**
 * Hand the child the session plane it cannot mint for itself. The promotion re-check
 * `apply` performs re-reads the task store its experiment names *and* each side run's
 * own session log (S4-E §Q3), and this fixture's sessions live in the boot's
 * *memory* — the log the real `TaskService` and the real session plane append to —
 * which a second process image cannot see. The logs travel as one file and are
 * replayed verbatim by the child: exactly what a deployment's on-disk logs give its
 * next process for nothing.
 */
async function handOverSessions(h: RunStack, directory: string): Promise<void> {
  await writeFile(join(directory, SESSION_HANDOVER), await exportSessionLogs(h), 'utf8')
}

/**
 * The settlement of one intent, after the host's own recovery entry ran: the
 * completion line that carries the intent's own grant and target, no open target
 * left, and a second reconciliation that is free — "重试可读", "无人工补账".
 */
async function settledBy(
  h: RunStack,
  reopened: EvolutionService,
  args: {
    readonly proposalId: string
    readonly direction: CommitDirection
    readonly target: string
    readonly intent: Record<string, unknown>
    readonly walked: readonly string[]
  },
): Promise<void> {
  const kind = args.direction === 'apply' ? 'applied' : 'rolledback'
  const settled = await ledgerLines(h)
  expect(kindsOf(settled)).toEqual([...args.walked, 'commit_intent', kind])
  expect(settled.filter(line => line.kind === kind)).toHaveLength(1)
  expect(settled.at(-1)).toMatchObject({
    kind,
    proposalId: args.proposalId,
    intentId: args.intent.intentId,
    targets: [args.target],
    approvalRef: args.intent.approvalRef,
  })
  expect(await reopened.openIntentTargets()).toEqual([])
  expect((await reopened.get(args.proposalId)).status).toBe(kind)
  const stable = await ledgerBytes(h)
  expect(await reopened.reconcile()).toEqual([])
  expect(await ledgerBytes(h)).toBe(stable)
}

/** The ledger's own lines, read from the file — never from a service's memory. */
async function ledgerLines(h: RunStack): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(ledgerRoot(h), 'proposals.jsonl'), 'utf8')
  return text.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
}

/** The ledger file exactly as it stands, for the "a query wrote nothing" assertions. */
async function ledgerBytes(h: RunStack): Promise<string> {
  return readFile(join(ledgerRoot(h), 'proposals.jsonl'), 'utf8')
}

function kindsOf(lines: readonly Record<string, unknown>[]): string[] {
  return lines.map(line => String(line.kind))
}

/**
 * One file of a commit intent's own line, as the intent records it (K3): the
 * absolute target, the digest production must hold before and after that file,
 * and the recoverable source under the ledger root. The guidance objects this
 * spec commits are one file, so index 0 is the object.
 */
function intentFile(intent: Record<string, unknown>, index = 0): { target: string; baselineSha256: string; contentSha256: string; source: string } {
  const files = intent.files as readonly { target: string; baselineSha256: string; contentSha256: string; source: string }[] | undefined
  if (files === undefined || files.length <= index) throw new Error(`the intent line names no file ${index}: ${JSON.stringify(intent)}`)
  return files[index]!
}

/** Every staging file left beside one production target (a commit removes its own, always). */
async function stagingFiles(h: RunStack, name: string = SKILL): Promise<string[]> {
  return (await readdir(join(h.home, 'skills', name))).filter(entry => entry.includes('.tmp-'))
}

/** One skill's production `SKILL.md`, read from disk — the bytes every assertion here is about. */
async function productionBytes(h: RunStack, name: string = SKILL): Promise<string> {
  return readFile(productionPath(h, name), 'utf8')
}

/**
 * Walk one skill candidate from `proposed` to `decided(PROMOTE)` through the
 * service's own entries, over a completed two-sided experiment recorded in a
 * fixture store of its own (two proposals in one case must not share a store:
 * the samples a promotion re-reads live there).
 */
async function walkToDecided(
  h: RunStack,
  svc: EvolutionService,
  proposalId: string,
  name: string,
  content: string,
  fixtureStore = PROMOTION_STORE,
): Promise<void> {
  await svc.propose({
    proposalId,
    targetType: 'skill',
    targetId: name,
    baseVersion: 'v1',
    level: 'L2',
    rationale: 'the fixture skill should carry the newer wording',
    sourceRefs: ['diagnosis:k2'],
  }, ROOT_A)
  await svc.candidate(proposalId, { skill: 'v2' }, ROOT_A, { name, content })
  await svc.prepare(proposalId, ROOT_A)
  const { reportPath } = await recordPromotionExperiment(promotionExperimentContext(h, fixtureStore), svc, {
    proposalId,
    selection: deploymentModelSelection(h.ctx)!,
  })
  await svc.gate(proposalId, {
    targetFailureFixed: 'the fixture criterion now passes',
    originalAcceptanceMaintained: 'the original criteria are unchanged and green',
    existingRegressionMaintained: 'the experiment replayed the suite green',
    noUnacceptableSideEffects: 'one SKILL.md changes',
    holdoutPerformanceAcceptable: 'the held-out sample still verifies',
    resourceCostAcceptable: 'the same runtime as the baseline',
    regressionEvidenceRefs: [reportPath],
  }, ROOT_A)
  await svc.decide(proposalId, 'PROMOTE', ROOT_A, `approval:decide-${proposalId}`)
}

/**
 * The root contract one session's tree is activated with (A0 §1.2). The
 * capabilities are declared only where the case is about the root's own
 * pre-check; the criteria are the ones every spec here uses.
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
  capability: string,
): Promise<{ childRunId: string; workerSessionId: SessionId }> {
  const batch = await h.runtime.decomposeAndRun(root.storeId, root.taskId, root.runId, sessionId, {
    reason: 'split the work',
    children: [child(`use the ${capability} skill`, [capability])],
  })
  const outcomes = await h.runtime.awaitBatch(root.storeId, batch.batchId)
  expect(outcomes.map(outcome => outcome.status)).toEqual(['verified'])
  const childRunId = outcomes[0]!.runId!
  return { childRunId, workerSessionId: (await h.task.runIn(root.storeId, childRunId)).sessionId as SessionId }
}

/** The refusal a batch was supposed to produce; an admitted batch is this helper's own failure. */
async function refusalOf(
  h: RunStack,
  sessionId: SessionId,
  root: { storeId: string; taskId: string; runId: string },
  capability: string,
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

/** The body the worker's own skill layer holds for one skill, as the registry serves it. */
async function registeredSkill(h: RunStack, agent: Agent, name: string): Promise<{ content: string; path?: string }> {
  const skill = await h.ctx.skills.get(name, { scope: agent, cwd: h.checkout })
  if (skill === undefined) throw new Error(`the worker's skill layer holds no "${name}"`)
  return skill as { content: string; path?: string }
}

/** The bytes one admitted run's own binding materialized — what that run was admitted against. */
async function boundSkill(h: RunStack, storeId: string, childRunId: string, name: string): Promise<string> {
  const binding = (await h.task.runIn(storeId, childRunId)).providerBinding
  if (binding?.snapshotRoot === undefined) throw new Error(`child run "${childRunId}" carries no provider binding snapshot`)
  return readFile(join(binding.snapshotRoot, name, 'SKILL.md'), 'utf8')
}

/** One tool call as the loop dispatches it, through the real definition. */
function toolRun(agent: Agent, callId: string) {
  return { agent, callId, signal: new AbortController().signal } as never
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

const CRASH_STAGES: readonly CommitStage[] = ['intent-recorded', 'write-staged', 'write-renamed']

describe('K2-2: a commit interrupted between two durable writes is settled by the process that reopens the directory', () => {
  it.each(CRASH_STAGES)('settles an apply interrupted after %s, and a new run loads the recovered version', async stage => {
    const directory = await sharedDirectory()
    const h1 = await startRunStack({ workspace: directory, roots: [ROOT_A], capabilities: { ...TABLE }, tools: true })
    await writeGuidanceSkill(join(h1.home, 'skills'), SKILL, V0)
    const target = productionPath(h1)

    // One proposal, walked to the state a commit starts from, over the real tool-less path.
    const crash = throwingProbe()
    const first = evolutionOf(h1, crash.probe)
    await walkToDecided(h1, first, P1, SKILL, skillText(V1, SKILL))
    const walked = kindsOf(await ledgerLines(h1))
    expect(walked.at(-1)).toBe('decided')
    expect(await productionBytes(h1)).toBe(skillText(V0, SKILL))

    // The process dies inside the commit, at the stage the probe was armed for.
    crash.arm(stage)
    await expect(first.apply(P1, ROOT_A, 'approval:k2-apply')).rejects.toThrow(/in-process probe threw after/)
    // The process died at the stage the probe was armed for: every earlier stage ran,
    // the armed one threw, and no later stage of that commit did.
    expect(crash.stages.at(-1)).toBe(stage)

    // What the crash left on disk: the intent line and no completion, and production
    // carrying one complete version — the old one everywhere the rename has not run.
    const interrupted = await ledgerLines(h1)
    expect(kindsOf(interrupted)).toEqual([...walked, 'commit_intent'])
    expect(interrupted.at(-1)).toMatchObject({
      kind: 'commit_intent',
      intentId: `${P1}/apply`,
      proposalId: P1,
      direction: 'apply',
      approvalRef: 'approval:k2-apply',
      // The object's fixed file set, in commit order: guidance is one file, so
      // the intent names exactly the `SKILL.md` this commit replaces.
      files: [{
        target,
        baselineSha256: sha256Of(skillText(V0, SKILL)),
        contentSha256: sha256Of(skillText(V1, SKILL)),
        source: `sandbox/${P1}/skills/${SKILL}/SKILL.md`,
      }],
    })
    expect(await productionBytes(h1)).toBe(stage === 'write-renamed' ? skillText(V1, SKILL) : skillText(V0, SKILL))
    // …and it is one of the two complete versions the intent names — never a third, half-written state.
    expect([sha256Of(skillText(V0, SKILL)), sha256Of(skillText(V1, SKILL))])
      .toContain(sha256Of(await productionBytes(h1)))
    expect(await stagingFiles(h1)).toEqual([])

    // The reopen: a second process image over the same directory, reading the ledger
    // and production off disk. Nothing is settled until the host settles it.
    const h2 = await startRunStack({ workspace: directory, roots: [ROOT_A], capabilities: { ...TABLE }, tools: true })
    const reopened = evolutionOf(h2)
    expect(await reopened.openIntentTargets()).toEqual([target])
    expect(await productionBytes(h2)).toBe(stage === 'write-renamed' ? skillText(V1, SKILL) : skillText(V0, SKILL))
    expect(h2.spawns).toHaveLength(0)

    // The host entry: the recovery barrier a restart runs before it takes a store over.
    const adoptedStore = rootTaskStoreId(ROOT_A)
    await h2.task.createStore(adoptedStore)
    const warnings = captureWarnings(h2)
    const adoption = await h2.runtime.adoptRoot(adoptedStore, ROOT_A)
    expect(adoption.adopted).toBe(false)
    // The barrier settled the intent: nothing about it is reported as a blocked commit.
    expect(warnings.filter(line => line.includes('could not be settled'))).toEqual([])

    // Production is the committed version, the intent is closed by exactly one
    // completion carrying the intent's own grant, and nothing was left behind.
    expect(await productionBytes(h2)).toBe(skillText(V1, SKILL))
    const settled = await ledgerLines(h2)
    expect(kindsOf(settled)).toEqual([...walked, 'commit_intent', 'applied'])
    expect(settled.filter(line => line.kind === 'applied')).toHaveLength(1)
    expect(settled.at(-1)).toMatchObject({
      kind: 'applied',
      proposalId: P1,
      intentId: `${P1}/apply`,
      targets: [target],
      approvalRef: 'approval:k2-apply',
    })
    expect(await stagingFiles(h2)).toEqual([])
    expect(await reopened.openIntentTargets()).toEqual([])
    expect((await reopened.get(P1)).status).toBe('applied')
    expect((await reopened.get(P1)).openIntent).toBeUndefined()

    // A second reconciliation is free: no line, no write, no outcome.
    const stable = await ledgerBytes(h2)
    expect(await reopened.reconcile()).toEqual([])
    expect(await ledgerBytes(h2)).toBe(stable)

    // …and the skill the reopened deployment admits a run against is the recovered one:
    // the worker's own layer resolves it, and the run's binding materialized those bytes.
    const root = await h2.root(ROOT_A, rootContract('ship the recovered release'))
    const admitted = await admitChild(h2, ROOT_A, root, ROW)
    const worker = h2.agent(admitted.workerSessionId)!
    expect((await registeredSkill(h2, worker, SKILL)).content).toContain(V1)
    expect(await boundSkill(h2, root.storeId, admitted.childRunId, SKILL)).toBe(skillText(V1, SKILL))
    await h2.runtime.submitResult(ROOT_A, { summary: 'the tree hands in the result its batch produced' })
  }, 120_000)

  it.each(CRASH_STAGES)('settles a rollback interrupted after %s, and a new run loads the restored version', async stage => {
    const directory = await sharedDirectory()
    const h1 = await startRunStack({ workspace: directory, roots: [ROOT_A], capabilities: { ...TABLE }, tools: true })
    await writeGuidanceSkill(join(h1.home, 'skills'), SKILL, V0)
    const target = productionPath(h1)

    const crash = throwingProbe()
    const first = evolutionOf(h1, crash.probe)
    await walkToDecided(h1, first, P1, SKILL, skillText(V1, SKILL))
    // A complete apply first: the state a rollback starts from, and the state it
    // must still find production in.
    await first.apply(P1, ROOT_A, 'approval:k2-apply')
    expect(await productionBytes(h1)).toBe(skillText(V1, SKILL))
    const applied = kindsOf(await ledgerLines(h1))
    expect(applied.slice(-2)).toEqual(['commit_intent', 'applied'])

    crash.arm(stage)
    await expect(first.rollback(P1, ROOT_A, 'approval:k2-rollback')).rejects.toThrow(/in-process probe threw after/)
    // The process died at the stage the probe was armed for: every earlier stage ran,
    // the armed one threw, and no later stage of that commit did.
    expect(crash.stages.at(-1)).toBe(stage)

    const interrupted = await ledgerLines(h1)
    expect(kindsOf(interrupted)).toEqual([...applied, 'commit_intent'])
    expect(interrupted.at(-1)).toMatchObject({
      kind: 'commit_intent',
      intentId: `${P1}/rollback`,
      proposalId: P1,
      direction: 'rollback',
      approvalRef: 'approval:k2-rollback',
      files: [{
        target,
        baselineSha256: sha256Of(skillText(V1, SKILL)),
        contentSha256: sha256Of(skillText(V0, SKILL)),
        source: `sandbox/${P1}/champion/skills/${SKILL}/SKILL.md`,
      }],
    })
    expect(await productionBytes(h1)).toBe(stage === 'write-renamed' ? skillText(V0, SKILL) : skillText(V1, SKILL))
    // …and it is one of the two complete versions the intent names — never a third, half-written state.
    expect([sha256Of(skillText(V1, SKILL)), sha256Of(skillText(V0, SKILL))])
      .toContain(sha256Of(await productionBytes(h1)))
    expect(await stagingFiles(h1)).toEqual([])

    const h2 = await startRunStack({ workspace: directory, roots: [ROOT_A], capabilities: { ...TABLE }, tools: true })
    const reopened = evolutionOf(h2)
    expect(await reopened.openIntentTargets()).toEqual([target])
    expect(await productionBytes(h2)).toBe(stage === 'write-renamed' ? skillText(V0, SKILL) : skillText(V1, SKILL))

    const adoptedStore = rootTaskStoreId(ROOT_A)
    await h2.task.createStore(adoptedStore)
    const adoption = await h2.runtime.adoptRoot(adoptedStore, ROOT_A)
    expect(adoption.adopted).toBe(false)

    expect(await productionBytes(h2)).toBe(skillText(V0, SKILL))
    const settled = await ledgerLines(h2)
    expect(kindsOf(settled)).toEqual([...applied, 'commit_intent', 'rolledback'])
    expect(settled.filter(line => line.kind === 'rolledback')).toHaveLength(1)
    expect(settled.at(-1)).toMatchObject({
      kind: 'rolledback',
      proposalId: P1,
      intentId: `${P1}/rollback`,
      targets: [target],
      approvalRef: 'approval:k2-rollback',
    })
    expect(await stagingFiles(h2)).toEqual([])
    expect(await reopened.openIntentTargets()).toEqual([])
    expect((await reopened.get(P1)).status).toBe('rolledback')

    const stable = await ledgerBytes(h2)
    expect(await reopened.reconcile()).toEqual([])
    expect(await ledgerBytes(h2)).toBe(stable)

    // The restored version is the one a run of the reopened deployment is admitted against.
    const root = await h2.root(ROOT_A, rootContract('ship the restored release'))
    const admitted = await admitChild(h2, ROOT_A, root, ROW)
    const worker = h2.agent(admitted.workerSessionId)!
    expect((await registeredSkill(h2, worker, SKILL)).content).toContain(V0)
    expect(await boundSkill(h2, root.storeId, admitted.childRunId, SKILL)).toBe(skillText(V0, SKILL))
    await h2.runtime.submitResult(ROOT_A, { summary: 'the tree hands in the result its batch produced' })
  }, 120_000)
})

/**
 * The real exit, at every durable window of both directions. The subject is the
 * commit mechanism `apply` and `rollback` share, so both run all three windows: a
 * mirror that tested fewer would leave the rollback's own staging leftover and its
 * "only the completion was missing" recovery unproven.
 *
 * Each case is a whole world. The parent sets it up (production `V0`, one proposal
 * decided, and — for a rollback — a real apply already landed by its own ledger),
 * spawns the nested child that performs the commit and dies inside it, reads what
 * that death left, reopens the same directory, refuses admission, runs the host's
 * recovery entry and checks the settlement. An exception from {@link throwingProbe}
 * cannot stand in for any of it: the two are kept apart by the assertions themselves
 * (the signal and the dead pid below; the "a throw is not an exit" case after them).
 *
 * The describe is skipped whenever the env names a window, i.e. inside the nested run
 * itself: the case that kills a process and the case that spawns one are never the
 * same process, so no child of a child can exist.
 */
describe.skipIf(EXIT_WINDOW !== undefined)('K2-2 (real exit): the process that commits is killed, and the host that reopens the directory settles it', () => {
  it.each(CRASH_STAGES)('settles an apply a killed process left interrupted after %s, redoing or completing it', async window => {
    const directory = await sharedDirectory()
    const h1 = await startRunStack({ workspace: directory, roots: [ROOT_A], capabilities: { ...TABLE }, tools: true })
    await writeGuidanceSkill(join(h1.home, 'skills'), SKILL, V0)
    const target = productionPath(h1)
    const first = evolutionOf(h1)
    await walkToDecided(h1, first, P1, SKILL, skillText(V1, SKILL))
    const walked = kindsOf(await ledgerLines(h1))
    expect(walked.at(-1)).toBe('decided')
    expect(await productionBytes(h1)).toBe(skillText(V0, SKILL))

    // A process image of its own performs the commit and is killed inside it: the
    // parent's own stack never ran this commit and never saw an exception from it.
    // The promotion store the child re-reads travels with the workspace, as the
    // session plane the dead child's own boot would have seen: the child replays it
    // before `apply` re-checks that evidence (S4-E §Q3).
    await handOverSessions(h1, directory)
    const child = await forcedExit(directory, spawnCommitChild(window, 'apply', directory))
    expect(child.window).toBe(window)
    expect(child.direction).toBe('apply')

    // What the death left on disk, read straight off the ledger file and the
    // production bytes: the intent line of this very commit, and no completion.
    const interrupted = await ledgerLines(h1)
    expect(kindsOf(interrupted)).toEqual([...walked, 'commit_intent'])
    const intent = interrupted.at(-1)!
    expect(intent).toMatchObject({
      kind: 'commit_intent',
      intentId: `${P1}/apply`,
      proposalId: P1,
      direction: 'apply',
      approvalRef: 'approval:k2-apply',
      files: [{
        target,
        baselineSha256: sha256Of(skillText(V0, SKILL)),
        contentSha256: sha256Of(skillText(V1, SKILL)),
        source: `sandbox/${P1}/skills/${SKILL}/SKILL.md`,
      }],
    })
    // Production is one of the two complete versions the intent names — never a
    // third, half-written state — and which one is the window: the old version until
    // the rename ran, the new one after it.
    expect(await productionBytes(h1)).toBe(window === 'write-renamed' ? skillText(V1, SKILL) : skillText(V0, SKILL))
    expect([sha256Of(skillText(V0, SKILL)), sha256Of(skillText(V1, SKILL))])
      .toContain(sha256Of(await productionBytes(h1)))
    // The staging file is a real death's signature: at `write-staged` the temp the
    // killed writer had fsynced beside the target is still there, named for the pid
    // that is gone, because no `catch` and no `finally` ever ran. At the other
    // windows no temp was written at all. (An in-process throw at `write-staged`
    // removes its own — see the case after these.)
    const staging = await stagingFiles(h1)
    if (window === 'write-staged') {
      expect(staging).toHaveLength(1)
      expect(staging[0]!.startsWith(`.SKILL.md.tmp-${child.pid}-`)).toBe(true)
    } else expect(staging).toEqual([])

    // The reopen: a second process image over the same directory, reading the ledger
    // and the production bytes off disk and nothing else. The open intent is what it
    // sees, and the gated capability is refused by name before any recovery ran (the
    // deep version of that gate is the K2-3 case). The refusal is asked of a *second*
    // root session, so the store the barrier below takes over is still unopened.
    const h2 = await startRunStack({ workspace: directory, roots: [ROOT_A, ROOT_B], capabilities: { ...TABLE }, tools: true })
    const reopened = evolutionOf(h2)
    expect(await reopened.openIntentTargets()).toEqual([target])
    await expect(h2.root(ROOT_B, rootContract('ship the killed release', [ROW]))).rejects.toThrow(/commit-intent-open/)
    expect(await reopened.openIntentTargets()).toEqual([target])
    expect(await productionBytes(h2)).toBe(window === 'write-renamed' ? skillText(V1, SKILL) : skillText(V0, SKILL))
    expect(h2.spawns).toHaveLength(0)

    // The host's own recovery entry: the barrier a restart runs before it takes a
    // store over.
    const before = window === 'write-renamed' ? await stat(target) : undefined
    const adoptedStore = rootTaskStoreId(ROOT_A)
    await h2.task.createStore(adoptedStore)
    const adoption = await h2.runtime.adoptRoot(adoptedStore, ROOT_A)
    expect(adoption.adopted).toBe(false)

    if (window === 'write-renamed') {
      // 仅补账: production already carried the committed content, so the host only
      // recorded the completion — the file the dead process's own rename left is not
      // touched: same inode, same mtime, same bytes.
      const after = await stat(target)
      expect({ ino: after.ino, mtimeMs: after.mtimeMs, size: after.size })
        .toEqual({ ino: before!.ino, mtimeMs: before!.mtimeMs, size: before!.size })
      expect(await productionBytes(h2)).toBe(skillText(V1, SKILL))
    } else {
      // 补做: production still held the version before the commit, so the host redid
      // the write — production now holds the intent's own content identity, whole …
      expect(await productionBytes(h2)).toBe(skillText(V1, SKILL))
      expect(sha256Of(await productionBytes(h2))).toBe(intentFile(intent).contentSha256)
    }
    // … and the staging file the real death left beside the target is gone: the
    // settlement swept the stale leftover of the target it was installing over.
    expect(await stagingFiles(h2)).toEqual([])

    await settledBy(h2, reopened, { proposalId: P1, direction: 'apply', target, intent, walked })
  }, 120_000)

  it.each(CRASH_STAGES)('settles a rollback a killed process left interrupted after %s, redoing or completing it', async window => {
    const directory = await sharedDirectory()
    const h1 = await startRunStack({ workspace: directory, roots: [ROOT_A], capabilities: { ...TABLE }, tools: true })
    await writeGuidanceSkill(join(h1.home, 'skills'), SKILL, V0)
    const target = productionPath(h1)
    const first = evolutionOf(h1)
    // The world a rollback starts from: `V1` applied by this ledger, through the real
    // commit path in this very process, nothing interrupted.
    await walkToDecided(h1, first, P1, SKILL, skillText(V1, SKILL))
    await first.apply(P1, ROOT_A, 'approval:k2-apply')
    expect(await productionBytes(h1)).toBe(skillText(V1, SKILL))
    const landed = kindsOf(await ledgerLines(h1))
    expect(landed.slice(-2)).toEqual(['commit_intent', 'applied'])

    // The promotion store travels with the workspace for both directions, as the
    // session plane the dead child's own boot would have seen: the child replays it
    // before it commits (`apply` is the direction whose re-check re-reads it).
    await handOverSessions(h1, directory)
    const child = await forcedExit(directory, spawnCommitChild(window, 'rollback', directory))
    expect(child.window).toBe(window)
    expect(child.direction).toBe('rollback')

    const interrupted = await ledgerLines(h1)
    expect(kindsOf(interrupted)).toEqual([...landed, 'commit_intent'])
    const intent = interrupted.at(-1)!
    expect(intent).toMatchObject({
      kind: 'commit_intent',
      intentId: `${P1}/rollback`,
      proposalId: P1,
      direction: 'rollback',
      approvalRef: 'approval:k2-rollback',
      files: [{
        target,
        baselineSha256: sha256Of(skillText(V1, SKILL)),
        contentSha256: sha256Of(skillText(V0, SKILL)),
        source: `sandbox/${P1}/champion/skills/${SKILL}/SKILL.md`,
      }],
    })
    expect(await productionBytes(h1)).toBe(window === 'write-renamed' ? skillText(V0, SKILL) : skillText(V1, SKILL))
    expect([sha256Of(skillText(V1, SKILL)), sha256Of(skillText(V0, SKILL))])
      .toContain(sha256Of(await productionBytes(h1)))
    const staging = await stagingFiles(h1)
    if (window === 'write-staged') {
      expect(staging).toHaveLength(1)
      expect(staging[0]!.startsWith(`.SKILL.md.tmp-${child.pid}-`)).toBe(true)
    } else expect(staging).toEqual([])

    // The reopen and the gate, as in the apply case: the open intent is visible and
    // the target it names is refused to admission before anything settled it — from a
    // second root session, so the store the barrier takes over is still unopened.
    const h2 = await startRunStack({ workspace: directory, roots: [ROOT_A, ROOT_B], capabilities: { ...TABLE }, tools: true })
    const reopened = evolutionOf(h2)
    expect(await reopened.openIntentTargets()).toEqual([target])
    await expect(h2.root(ROOT_B, rootContract('ship the killed release', [ROW]))).rejects.toThrow(/commit-intent-open/)
    expect(await reopened.openIntentTargets()).toEqual([target])
    expect(await productionBytes(h2)).toBe(window === 'write-renamed' ? skillText(V0, SKILL) : skillText(V1, SKILL))

    const before = window === 'write-renamed' ? await stat(target) : undefined
    const adoptedStore = rootTaskStoreId(ROOT_A)
    await h2.task.createStore(adoptedStore)
    const adoption = await h2.runtime.adoptRoot(adoptedStore, ROOT_A)
    expect(adoption.adopted).toBe(false)

    if (window === 'write-renamed') {
      // 仅补账: the rename had landed, so only the completion was missing and the
      // restored file the dead process wrote stays exactly as it is.
      const after = await stat(target)
      expect({ ino: after.ino, mtimeMs: after.mtimeMs, size: after.size })
        .toEqual({ ino: before!.ino, mtimeMs: before!.mtimeMs, size: before!.size })
      expect(await productionBytes(h2)).toBe(skillText(V0, SKILL))
    } else {
      // 补做: production still held the applied version, so the rollback was redone
      // and the baseline it names is what production holds now.
      expect(await productionBytes(h2)).toBe(skillText(V0, SKILL))
      expect(sha256Of(await productionBytes(h2))).toBe(intentFile(intent).contentSha256)
    }
    expect(await stagingFiles(h2)).toEqual([])

    await settledBy(h2, reopened, { proposalId: P1, direction: 'rollback', target, intent, walked: landed })
  }, 120_000)

  it('keeps an in-process throw apart from that real exit: its staging file is removed and the same instance settles the intent', async () => {
    const directory = await sharedDirectory()
    const h = await startRunStack({ workspace: directory, roots: [ROOT_A], capabilities: { ...TABLE }, tools: true })
    await writeGuidanceSkill(join(h.home, 'skills'), SKILL, V0)
    const crash = throwingProbe()
    const svc = evolutionOf(h, crash.probe)
    await walkToDecided(h, svc, P1, SKILL, skillText(V1, SKILL))

    // The throw is caught by this very process, and that is the whole difference from
    // the cases above: `writeFileAtomic`'s `catch` runs, so the staging file of a
    // `write-staged` throw is already gone where the real death leaves it behind.
    crash.arm('write-staged')
    await expect(svc.apply(P1, ROOT_A, 'approval:k2-apply')).rejects.toThrow(/in-process probe threw after/)
    expect(await stagingFiles(h)).toEqual([])
    expect(await productionBytes(h)).toBe(skillText(V0, SKILL))

    // …and the process that threw is still here with its instance: it settles its own
    // open intent in this same process — production still held the version before the
    // commit, so the write is redone and the completion recorded. A real exit has no
    // such next step: nothing in the killed process can run again, and only the
    // reopened image above can settle what it left.
    const outcomes = await svc.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({
      intentId: `${P1}/apply`,
      proposalId: P1,
      direction: 'apply',
      targets: [productionPath(h)],
      result: 'completed-redone',
    })
    expect(await productionBytes(h)).toBe(skillText(V1, SKILL))
    expect(kindsOf(await ledgerLines(h)).slice(-2)).toEqual(['commit_intent', 'applied'])
    expect(await svc.openIntentTargets()).toEqual([])
  }, 120_000)
})

/**
 * The killed half, and the one case a nested run executes. It exists only under the
 * env {@link spawnCommitChild} sets: without it the whole describe — and with it the
 * only `process.kill` in this file — is skipped, so an ordinary suite can never kill
 * a process, no matter what it runs.
 */
describe.skipIf(EXIT_WINDOW === undefined)('K2-2 (nested child): the process image that dies inside the commit', () => {
  it(CHILD_CASE, async () => {
    const window = EXIT_WINDOW!
    const workspace = EXIT_WORKSPACE
    if (workspace === undefined) throw new Error('the child case runs only under the env its parent sets: K2_REAL_EXIT_WORKSPACE is missing')

    // A process image of its own over the parent's directory: it reads the decided
    // proposal off the ledger, reads the production bytes, and its probe exits the
    // process at the armed window by SIGKILL — no `catch`, no `finally`, no cleanup
    // of the stage it died in, which is exactly what a killed deployment does.
    const h = await startRunStack({ workspace })
    // The session plane the parent handed over, replayed into this boot's memory
    // before anything re-reads it: `apply` re-checks the promotion against the store
    // and the side runs' own logs (S4-E §Q3).
    await replaySessionLogs(h, await readFile(join(workspace, SESSION_HANDOVER), 'utf8'))
    const svc = evolutionOf(h, stage => {
      if (stage === window) process.kill(process.pid, 'SIGKILL')
    })
    // Written before that call: this pid is the parent's proof of which process image
    // performed the commit. Everything below the call is dead code.
    await writeFile(
      join(workspace, EXIT_MARKER),
      `${JSON.stringify({ window, direction: EXIT_DIRECTION, pid: process.pid }, null, 2)}\n`,
      'utf8',
    )
    if (EXIT_DIRECTION === 'rollback') await svc.rollback(P1, ROOT_A, 'approval:k2-rollback')
    else await svc.apply(P1, ROOT_A, 'approval:k2-apply')
  }, 120_000)
})

describe('K2-3: an open commit intent blocks the real admission until a reconciliation settles it', () => {
  it('refuses the gated capability by name with no evolution tool registered, and admits it again after the host reconciled', async () => {
    const directory = await sharedDirectory()
    const h1 = await startRunStack({ workspace: directory, roots: [ROOT_A], capabilities: { ...TABLE }, tools: true })
    await writeGuidanceSkill(join(h1.home, 'skills'), SKILL, V0)
    await writeGuidanceSkill(join(h1.home, 'skills'), CLEAN_SKILL, V0)
    const target = productionPath(h1)

    // A commit interrupted after the rename: production already carries the new
    // version and the ledger says its completion was never recorded.
    const crash = throwingProbe()
    const first = evolutionOf(h1, crash.probe)
    await walkToDecided(h1, first, P1, SKILL, skillText(V1, SKILL))
    crash.arm('write-renamed')
    await expect(first.apply(P1, ROOT_A, 'approval:k2-apply')).rejects.toThrow(/in-process probe threw after/)
    expect(await productionBytes(h1)).toBe(skillText(V1, SKILL))

    // The reopened deployment: a new process image, the ledger read from disk, and
    // no evolution tool on the root's surface at all — the switch a deployment
    // would have off. The gate below is therefore the service's, not a tool's.
    const h2 = await startRunStack({
      workspace: directory,
      roots: [ROOT_A, ROOT_B, ROOT_C],
      capabilities: { ...TABLE },
      tools: true,
    })
    const reopened = evolutionOf(h2)
    expect(h2.visible(h2.rootAgent(ROOT_A)).filter(name => name.startsWith('evolution_'))).toEqual([])
    expect(await reopened.openIntentTargets()).toEqual([target])

    // 1. The root intake: a contract naming the gated capability is refused by name,
    //    before a root task, a run or a spawn exists.
    const intakeStore = rootTaskStoreId(ROOT_A)
    await expect(h2.root(ROOT_A, rootContract('ship the gated release', [ROW]))).rejects.toThrow(/commit-intent-open/)
    const afterIntake = await h2.snapshot(intakeStore)
    expect(afterIntake.tasks).toEqual([])
    expect(afterIntake.runs).toEqual([])
    expect(h2.events(intakeStore)).toEqual([])
    expect(h2.spawns).toHaveLength(0)

    // 2. A decomposition under a plain root: the whole batch is refused, the skill
    //    and the capability named, and nothing was written.
    const root = await h2.root(ROOT_B, rootContract('ship the ungated release'))
    const eventsBefore = h2.events(root.storeId)
    const snapshotBefore = await h2.snapshot(root.storeId)
    const spawnsBefore = h2.spawns.length
    const refusal = await refusalOf(h2, ROOT_B, root, ROW)
    expect(refusal).toContain('provider pre-check rejected decomposition')
    expect(refusal).toContain(`capability "${ROW}"`)
    expect(refusal).toContain(`skill "${SKILL}"`)
    expect(refusal).toContain('commit-intent-open')
    expect(refusal).toContain('open evolution commit intent')
    expect(h2.events(root.storeId)).toEqual(eventsBefore)
    expect(await h2.snapshot(root.storeId)).toEqual(snapshotBefore)
    expect(h2.spawns).toHaveLength(spawnsBefore)

    // 3. A skill no intent names is unaffected: the same root admits it and the
    //    worker loads it, while the intent is still open.
    const clean = await admitChild(h2, ROOT_B, root, CLEAN_ROW)
    expect((await registeredSkill(h2, h2.agent(clean.workerSessionId)!, CLEAN_SKILL)).content).toContain(V0)
    expect(await productionBytes(h2)).toBe(skillText(V1, SKILL))
    // The settled tree hands its checkout back, so the next root can take it (K1 §2).
    await h2.runtime.submitResult(ROOT_B, { summary: 'the ungated tree hands in the result its batch produced' })

    // 4. A query is a query: the real evolution_list reads the open intent off the
    //    ledger and writes nothing.
    const queried = await ledgerBytes(h2)
    const listed = await defineEvolutionListTool(h2.ctx).execute({} as never, toolRun(h2.rootAgent(ROOT_A), 'call-list'))
    expect(String(listed)).toContain(`${P1}/apply`)
    expect(String(listed)).toContain('open commit intent')
    expect(await reopened.openIntentTargets()).toEqual([target])
    expect(await reopened.list()).toHaveLength(1)
    expect(await ledgerBytes(h2)).toBe(queried)

    // 5. The host reconciles — a restarted deployment's barrier, on a store of its
    //    own — and then the same two admissions pass, against the recovered bytes.
    const barrierStore = rootTaskStoreId(ROOT_C)
    await h2.task.createStore(barrierStore)
    await h2.runtime.adoptRoot(barrierStore, ROOT_C)
    expect(await reopened.openIntentTargets()).toEqual([])
    const settledKinds = kindsOf(await ledgerLines(h2))
    expect(settledKinds.slice(-2)).toEqual(['commit_intent', 'applied'])
    expect((await reopened.get(P1)).status).toBe('applied')

    const recovered = await h2.root(ROOT_A, rootContract('ship the gated release', [ROW]))
    const admitted = await admitChild(h2, ROOT_A, recovered, ROW)
    expect((await registeredSkill(h2, h2.agent(admitted.workerSessionId)!, SKILL)).content).toContain(V1)
    expect(await boundSkill(h2, recovered.storeId, admitted.childRunId, SKILL)).toBe(skillText(V1, SKILL))
    await h2.runtime.submitResult(ROOT_A, { summary: 'the tree hands in the result its batch produced' })
  }, 120_000)
})

describe('K2-4: a tampered target and two proposals competing for one target', () => {
  it('stops the reconciliation by name when a third party rewrote the open target, and keeps refusing admission', async () => {
    const directory = await sharedDirectory()
    const h1 = await startRunStack({ workspace: directory, roots: [ROOT_A], capabilities: { ...TABLE }, tools: true })
    await writeGuidanceSkill(join(h1.home, 'skills'), SKILL, V0)
    const target = productionPath(h1)

    const crash = throwingProbe()
    const first = evolutionOf(h1, crash.probe)
    await walkToDecided(h1, first, P1, SKILL, skillText(V1, SKILL))
    crash.arm('intent-recorded')
    await expect(first.apply(P1, ROOT_A, 'approval:k2-apply')).rejects.toThrow(/in-process probe threw after/)
    expect(await productionBytes(h1)).toBe(skillText(V0, SKILL))
    const interrupted = await ledgerBytes(h1)

    // A third party rewrites production while the intent is open.
    const thirdParty = skillText(THIRD_PARTY, SKILL)
    await writeFile(target, thirdParty, 'utf8')

    const h2 = await startRunStack({ workspace: directory, roots: [ROOT_A, ROOT_B], capabilities: { ...TABLE }, tools: true })
    const reopened = evolutionOf(h2)
    expect(await reopened.openIntentTargets()).toEqual([target])

    // The host barrier completes — a blocked commit does not fail the takeover — and
    // reports it by name, the way a deployment's log would show it.
    const adoptedStore = rootTaskStoreId(ROOT_A)
    await h2.task.createStore(adoptedStore)
    const warnings = captureWarnings(h2)
    const adoption = await h2.runtime.adoptRoot(adoptedStore, ROOT_A)
    expect(adoption.adopted).toBe(false)
    expect(warnings.join('\n')).toContain(`${P1}/apply`)
    expect(warnings.join('\n')).toContain('could not be settled')
    // The warning names the actual production targets the intent committed (K3:
    // the outcome carries `targets`, and the barrier must print them — a
    // `targeting undefined` log is the defect this assertion pins).
    expect(warnings.join('\n')).toContain(target)
    expect(warnings.join('\n')).toContain('a third party changed it')

    // Named blocked, with production exactly as the third party left it, the intent
    // still open and no line written.
    const outcomes = await reopened.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ intentId: `${P1}/apply`, proposalId: P1, direction: 'apply', targets: [target], result: 'blocked' })
    expect(outcomes[0]!.detail).toMatch(/a third party changed it/)
    expect(outcomes[0]!.detail).toMatch(/the intent stays open/)
    expect(await productionBytes(h2)).toBe(thirdParty)
    expect(await ledgerBytes(h2)).toBe(interrupted)
    expect(await reopened.openIntentTargets()).toEqual([target])
    expect((await reopened.get(P1)).openIntent?.intentId).toBe(`${P1}/apply`)
    expect((await reopened.get(P1)).status).toBe('decided')

    // Admission still refuses the provider the intent names, with zero writes.
    const root = await h2.root(ROOT_B, rootContract('ship the tampered release'))
    const eventsBefore = h2.events(root.storeId)
    const spawnsBefore = h2.spawns.length
    const refusal = await refusalOf(h2, ROOT_B, root, ROW)
    expect(refusal).toContain('commit-intent-open')
    expect(h2.events(root.storeId)).toEqual(eventsBefore)
    expect(h2.spawns).toHaveLength(spawnsBefore)
    expect(await productionBytes(h2)).toBe(thirdParty)
  }, 120_000)

  it('refuses the earlier proposal a rollback over the later one, and rolls the later one back to the earlier content', async () => {
    const directory = await sharedDirectory()
    const h = await startRunStack({ workspace: directory, roots: [ROOT_A], capabilities: { ...TABLE }, tools: true })
    await writeGuidanceSkill(join(h.home, 'skills'), SKILL, V0)
    const target = productionPath(h)
    const svc = evolutionOf(h)

    // s1 replaces v0 with v1 and lands in production.
    await walkToDecided(h, svc, P1, SKILL, skillText(V1, SKILL), 's-k2-fixture-p1')
    await svc.apply(P1, ROOT_A, 'approval:k2-apply')
    expect(await productionBytes(h)).toBe(skillText(V1, SKILL))

    // s2 is prepared against what s1 left in production and lands on top of it.
    await walkToDecided(h, svc, P2, SKILL, skillText(V2, SKILL), 's-k2-fixture-p2')
    const [one, two] = [await svc.get(P1), await svc.get(P2)]
    expect(one.prepared!.skillContent!.sha256).toBe(sha256Of(skillText(V1, SKILL)))
    expect(two.prepared!.skillBaseline!.sha256).toBe(sha256Of(skillText(V1, SKILL)))
    await svc.apply(P2, ROOT_A, 'approval:k2-apply')
    expect(await productionBytes(h)).toBe(skillText(V2, SKILL))
    const landed = await ledgerBytes(h)

    // s1's rollback would restore v0 over s2's version: refused by name, with no line
    // and no write.
    const refusal = await svc.rollback(P1, ROOT_A, 'approval:k2-rollback')
      .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(refusal).toContain(`does not hold the content proposal "${P1}" applied`)
    expect(refusal).toContain('nothing was written and no commit intent was recorded')
    expect(await productionBytes(h)).toBe(skillText(V2, SKILL))
    expect(await ledgerBytes(h)).toBe(landed)
    expect((await svc.get(P1)).status).toBe('applied')
    expect((await svc.get(P1)).openIntent).toBeUndefined()

    // s2's own rollback restores its own baseline — s1's version.
    const outcome = await svc.rollback(P2, ROOT_A, 'approval:k2-rollback')
    expect(outcome.proposal.status).toBe('rolledback')
    expect(outcome.targets).toEqual([target])
    expect(await productionBytes(h)).toBe(skillText(V1, SKILL))
    const lines = await ledgerLines(h)
    expect(lines.filter(line => line.kind === 'rolledback').map(line => line.proposalId)).toEqual([P2])
    expect(lines.filter(line => line.kind === 'applied').map(line => line.proposalId)).toEqual([P1, P2])
    expect((await svc.get(P1)).status).toBe('applied')
    expect(await svc.openIntentTargets()).toEqual([])
  }, 120_000)

  it('refuses a fresh apply the target another proposal left open, and admits commits again once that intent is settled', async () => {
    const directory = await sharedDirectory()
    const h = await startRunStack({
      workspace: directory,
      roots: [ROOT_A],
      capabilities: { ...TABLE },
      tools: true,
      evolution: true,
    })
    await writeGuidanceSkill(join(h.home, 'skills'), SKILL, V0)
    await writeGuidanceSkill(join(h.home, 'skills'), CLEAN_SKILL, V0)
    const target = productionPath(h)

    // The world the failure needs: two proposals prepared against the same
    // production bytes — each with a promotion store of its own — and both decided
    // while production still holds `V0`. Their recorded baselines are therefore one
    // and the same digest, which is why P2's own baseline check cannot keep its
    // commit off a target P1's unfinished commit also names.
    const crash = throwingProbe()
    const svc = evolutionOf(h, crash.probe)
    await walkToDecided(h, svc, P1, SKILL, skillText(V1, SKILL), 's-k2-fixture-p1')
    await walkToDecided(h, svc, P2, SKILL, skillText(V2, SKILL), 's-k2-fixture-p2')
    expect(await productionBytes(h)).toBe(skillText(V0, SKILL))
    expect((await svc.get(P1)).prepared!.skillBaseline!.sha256).toBe(sha256Of(skillText(V0, SKILL)))
    expect((await svc.get(P2)).prepared!.skillBaseline!.sha256).toBe(sha256Of(skillText(V0, SKILL)))

    // P1 records its intent and the process dies inside the commit: production is
    // still `V0` and that intent is the line the commit left open.
    crash.arm('intent-recorded')
    await expect(svc.apply(P1, ROOT_A, 'approval:k2-apply')).rejects.toThrow(/in-process probe threw after/)
    expect(await productionBytes(h)).toBe(skillText(V0, SKILL))
    const interrupted = await ledgerBytes(h)
    expect(kindsOf(await ledgerLines(h)).at(-1)).toBe('commit_intent')
    expect(await svc.openIntentTargets()).toEqual([target])
    expect((await svc.get(P1)).openIntent?.intentId).toBe(`${P1}/apply`)
    expect((await svc.get(P2)).status).toBe('decided')
    expect((await svc.get(P2)).openIntent).toBeUndefined()

    // P2's commit is refused by name before it can move the target: a byte and a
    // line of its own are what it would otherwise add while P1's intent stands.
    // The gate names the production *directory* the intent touches (K3), because
    // one intent covers a skill's fixed file set together.
    const refusal = await svc.apply(P2, ROOT_A, 'approval:k2-apply')
      .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(refusal).toContain(productionDirectory(h))
    expect(refusal).toContain(`${P1}/apply`)
    expect(refusal).toContain(`proposal "${P1}"`)
    expect(refusal).toContain("another proposal's unsettled intent")
    expect(refusal).toContain('nothing was written and no commit intent was recorded')
    expect(await productionBytes(h)).toBe(skillText(V0, SKILL))
    expect(await ledgerBytes(h)).toBe(interrupted)
    expect(await stagingFiles(h)).toEqual([])
    expect((await svc.get(P2)).status).toBe('decided')
    expect((await svc.get(P2)).openIntent).toBeUndefined()
    expect((await svc.get(P1)).openIntent?.intentId).toBe(`${P1}/apply`)

    // The real entry a root agent calls answers with the same refusal: the tool
    // returns the service's own text, not a commit — production and the ledger
    // stand exactly as the interrupted commit left them.
    h.rootAgent(ROOT_A).ctx.tools.register(defineEvolutionApplyTool(h.ctx))
    const answered = await h.call(h.rootAgent(ROOT_A), 'evolution_apply', { proposalId: P2 })
    expect(answered.isError, answered.text).toBe(false)
    expect(answered.text).toContain('evolution_apply rejected:')
    expect(answered.text).toContain(productionDirectory(h))
    expect(answered.text).toContain(`${P1}/apply`)
    expect(answered.text).toContain("another proposal's unsettled intent")
    expect(answered.text).toContain('nothing was written and no commit intent was recorded')
    expect(await productionBytes(h)).toBe(skillText(V0, SKILL))
    expect(await ledgerBytes(h)).toBe(interrupted)
    expect(await svc.openIntentTargets()).toEqual([target])

    // A target no open intent names is not blocked by the intent of another: the
    // clean skill commits while P1's intent stays open.
    await walkToDecided(h, svc, Q1, CLEAN_SKILL, skillText(V1, CLEAN_SKILL), 's-k2-fixture-clean')
    await svc.apply(Q1, ROOT_A, 'approval:k2-apply')
    expect(await productionBytes(h, CLEAN_SKILL)).toBe(skillText(V1, CLEAN_SKILL))
    expect(await productionBytes(h)).toBe(skillText(V0, SKILL))
    expect(await svc.openIntentTargets()).toEqual([target])

    // The host's recovery entry settles the intent — production still held the
    // version before the commit, so the write is redone — and the target it names
    // takes commits again.
    const outcomes = await svc.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({
      intentId: `${P1}/apply`,
      proposalId: P1,
      direction: 'apply',
      targets: [target],
      result: 'completed-redone',
    })
    expect(await productionBytes(h)).toBe(skillText(V1, SKILL))
    expect((await svc.get(P1)).status).toBe('applied')
    expect(await svc.openIntentTargets()).toEqual([])

    // With nothing open the stale second proposal is refused by the pre-existing
    // rule the gate was standing on: it was evaluated against `V0`, which
    // production no longer holds. Zero write, zero line.
    const recovered = await ledgerBytes(h)
    const stale = await svc.apply(P2, ROOT_A, 'approval:k2-apply')
      .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(stale).toContain('changed since prepare')
    expect(await productionBytes(h)).toBe(skillText(V1, SKILL))
    expect(await ledgerBytes(h)).toBe(recovered)

    // A legal commit lands: a proposal prepared against the recovered production.
    await walkToDecided(h, svc, P3, SKILL, skillText(V2, SKILL), 's-k2-fixture-p3')
    await svc.apply(P3, ROOT_A, 'approval:k2-apply')
    expect(await productionBytes(h)).toBe(skillText(V2, SKILL))
    expect((await svc.get(P3)).status).toBe('applied')
    expect(kindsOf(await ledgerLines(h)).slice(-2)).toEqual(['commit_intent', 'applied'])
    expect(await svc.openIntentTargets()).toEqual([])
  }, 120_000)

  it('refuses a rollback the target another proposal left open, and restores it once that intent is settled', async () => {
    const directory = await sharedDirectory()
    const h = await startRunStack({ workspace: directory, roots: [ROOT_A], capabilities: { ...TABLE }, tools: true })
    await writeGuidanceSkill(join(h.home, 'skills'), SKILL, V0)
    const target = productionPath(h)
    const crash = throwingProbe()
    const svc = evolutionOf(h, crash.probe)

    // `V1` lands through the real commit path, and the second proposal is prepared
    // against what that apply left in production.
    await walkToDecided(h, svc, P1, SKILL, skillText(V1, SKILL), 's-k2-fixture-p1')
    await svc.apply(P1, ROOT_A, 'approval:k2-apply')
    expect(await productionBytes(h)).toBe(skillText(V1, SKILL))
    await walkToDecided(h, svc, P2, SKILL, skillText(V2, SKILL), 's-k2-fixture-p2')
    expect((await svc.get(P2)).prepared!.skillBaseline!.sha256).toBe(sha256Of(skillText(V1, SKILL)))

    // The later proposal's own commit records its intent and dies inside it:
    // production still holds `V1`, the version the earlier proposal installed and
    // the one its rollback would restore.
    crash.arm('intent-recorded')
    await expect(svc.apply(P2, ROOT_A, 'approval:k2-apply')).rejects.toThrow(/in-process probe threw after/)
    expect(await productionBytes(h)).toBe(skillText(V1, SKILL))
    const interrupted = await ledgerBytes(h)
    expect(kindsOf(await ledgerLines(h)).at(-1)).toBe('commit_intent')
    expect(await svc.openIntentTargets()).toEqual([target])
    expect((await svc.get(P2)).openIntent?.intentId).toBe(`${P2}/apply`)

    // The earlier proposal's rollback would restore `V0` out from under the later
    // proposal's unsettled intent — the direction that must not read those bytes as
    // its own to overwrite. Refused by name, no byte, no line.
    const refusal = await svc.rollback(P1, ROOT_A, 'approval:k2-rollback')
      .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(refusal).toContain(productionDirectory(h))
    expect(refusal).toContain(`${P2}/apply`)
    expect(refusal).toContain(`proposal "${P2}"`)
    expect(refusal).toContain("another proposal's unsettled intent")
    expect(refusal).toContain('nothing was written and no commit intent was recorded')
    expect(await productionBytes(h)).toBe(skillText(V1, SKILL))
    expect(await ledgerBytes(h)).toBe(interrupted)
    expect(await stagingFiles(h)).toEqual([])
    expect((await svc.get(P1)).status).toBe('applied')
    expect((await svc.get(P1)).openIntent).toBeUndefined()

    // The host settles the intent — the write the dead commit had not made is
    // redone — and the target takes commits again.
    const outcomes = await svc.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({
      intentId: `${P2}/apply`,
      proposalId: P2,
      direction: 'apply',
      targets: [target],
      result: 'completed-redone',
    })
    expect(await productionBytes(h)).toBe(skillText(V2, SKILL))
    expect((await svc.get(P2)).status).toBe('applied')

    // The pre-existing rule still stands with nothing open: the earlier rollback
    // may not overwrite the version a later proposal installed.
    const recovered = await ledgerBytes(h)
    const late = await svc.rollback(P1, ROOT_A, 'approval:k2-rollback')
      .then(() => '', (error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(late).toContain(`does not hold the content proposal "${P1}" applied`)
    expect(late).toContain('nothing was written and no commit intent was recorded')
    expect(await productionBytes(h)).toBe(skillText(V2, SKILL))
    expect(await ledgerBytes(h)).toBe(recovered)

    // The later proposal's own rollback restores the baseline it recorded — the
    // earlier proposal's version.
    const outcome = await svc.rollback(P2, ROOT_A, 'approval:k2-rollback')
    expect(outcome.proposal.status).toBe('rolledback')
    expect(outcome.targets).toEqual([target])
    expect(await productionBytes(h)).toBe(skillText(V1, SKILL))
    expect((await svc.get(P2)).status).toBe('rolledback')
    expect(await svc.openIntentTargets()).toEqual([])
  }, 120_000)
})

describe('K2-5: a reopened instance rolls an applied proposal back through the real tool', () => {
  it('rolls back over a formatVersion 4 ledger the reopened process read from disk', async () => {
    const directory = await sharedDirectory()
    const h1 = await startRunStack({ workspace: directory, roots: [ROOT_A], capabilities: { ...TABLE }, tools: true })
    await writeGuidanceSkill(join(h1.home, 'skills'), SKILL, V0)
    const target = productionPath(h1)
    const first = evolutionOf(h1)
    await walkToDecided(h1, first, P1, SKILL, skillText(V1, SKILL))
    await first.apply(P1, ROOT_A, 'approval:k2-apply')
    expect(await productionBytes(h1)).toBe(skillText(V1, SKILL))

    // The reopen: a new process image over the same directory. Every line it reads is
    // the one format this build writes, and the proposal is applied with nothing open.
    const h2 = await startRunStack({
      workspace: directory,
      roots: [ROOT_A],
      capabilities: { ...TABLE },
      tools: true,
      evolution: true,
    })
    const reopened = evolutionOf(h2)
    const lines = await ledgerLines(h2)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every(line => line.formatVersion === 4)).toBe(true)
    expect(kindsOf(lines).slice(-2)).toEqual(['commit_intent', 'applied'])
    expect((await reopened.get(P1)).status).toBe('applied')
    expect((await reopened.get(P1)).openIntent).toBeUndefined()

    // The rollback runs through the real tool on the reopened process's own surface.
    h2.rootAgent(ROOT_A).ctx.tools.register(defineEvolutionRollbackTool(h2.ctx))
    const answer = await h2.call(h2.rootAgent(ROOT_A), 'evolution_rollback', { proposalId: P1 })
    expect(answer.isError, answer.text).toBe(false)
    expect(answer.text).toContain('champion restored')
    expect(answer.text).toContain(target)

    expect(await productionBytes(h2)).toBe(skillText(V0, SKILL))
    const settled = await ledgerLines(h2)
    expect(kindsOf(settled).slice(-2)).toEqual(['commit_intent', 'rolledback'])
    const rolledback = settled.at(-1)!
    expect(rolledback).toMatchObject({
      kind: 'rolledback',
      proposalId: P1,
      intentId: `${P1}/rollback`,
      targets: [target],
    })
    expect(String(rolledback.approvalRef)).toMatch(/^approval:/)
    expect(settled.every(line => line.formatVersion === 4)).toBe(true)
    expect((await reopened.get(P1)).status).toBe('rolledback')
    expect(await reopened.openIntentTargets()).toEqual([])

    // A further rollback is the state machine's answer, not a second write.
    const afterRollback = await ledgerBytes(h2)
    const again = await h2.call(h2.rootAgent(ROOT_A), 'evolution_rollback', { proposalId: P1 })
    expect(again.text).toContain('is rolledback; only an applied proposal can be rolled back')
    expect(await ledgerBytes(h2)).toBe(afterRollback)
    expect(kindsOf(await ledgerLines(h2)).slice(-2)).toEqual(['commit_intent', 'rolledback'])
  }, 120_000)
})

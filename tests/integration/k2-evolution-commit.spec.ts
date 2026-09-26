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
 * crash itself — {@link crashProbe} throws from the service's typed
 * `commitProbe` at one durable stage, which is exactly what a process exiting
 * there leaves behind. The two-sided experiment each candidate is promoted from
 * is the recorded-report fixture (`tests/support/promotion-experiment.ts`); the
 * real orchestration of that experiment is proven in
 * `tests/integration/evolution-replay-experiment.spec.ts` and
 * `tests/integration/experiment-runner.spec.ts`.
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

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { CapabilityConfig, DecomposeSpec, RootContractSpec } from '../../task-runtime/src/index.ts'
import { EvolutionService } from '../../evolution/src/index.ts'
import type { CommitStage } from '../../evolution/src/commit.ts'
import { deploymentModelSelection } from '../../agent-singularity/src/index.ts'
import { defineEvolutionListTool } from '../../agent-singularity/src/tools/evolution-list.ts'
import { defineEvolutionRollbackTool } from '../../agent-singularity/src/tools/evolution-rollback.ts'
import { promotionExperimentContext, recordPromotionExperiment } from '../support/promotion-experiment.ts'
import { disposeRunStacks, sha256Of, skillText, startRunStack, writeGuidanceSkill, type RunStack } from '../support/run-stack.ts'

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
/** The three production versions this spec moves between; each is compared byte for byte. */
const V0 = 'K2 VERSION ZERO BODY'
const V1 = 'K2 VERSION ONE BODY'
const V2 = 'K2 VERSION TWO BODY'
/** The version a third party writes while a commit intent is open. */
const THIRD_PARTY = 'K2 A VERSION NO COMMIT OF THIS LEDGER WROTE'

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

/** The evolution plane of one boot, over the shared ledger root and the production skill root. */
function evolutionOf(h: RunStack, commitProbe?: (stage: CommitStage) => void): EvolutionService {
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
 * The typed crash seam: `arm` names the one durable stage this process dies
 * after, and the probe throws there — the intent stays open and no later stage
 * of that commit runs.
 */
function crashProbe(): { probe: (stage: CommitStage) => void; arm: (stage: CommitStage) => void; stages: CommitStage[] } {
  const stages: CommitStage[] = []
  let armed: CommitStage | undefined
  return {
    stages,
    arm: stage => { armed = stage },
    probe: stage => {
      stages.push(stage)
      if (stage !== armed) return
      armed = undefined
      throw new Error(`k2 fixture: simulated process exit after "${stage}"`)
    },
  }
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
  fixtureStore = 's-k2-promotion-fixture',
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
    const crash = crashProbe()
    const first = evolutionOf(h1, crash.probe)
    await walkToDecided(h1, first, P1, SKILL, skillText(V1, SKILL))
    const walked = kindsOf(await ledgerLines(h1))
    expect(walked.at(-1)).toBe('decided')
    expect(await productionBytes(h1)).toBe(skillText(V0, SKILL))

    // The process dies inside the commit, at the stage the probe was armed for.
    crash.arm(stage)
    await expect(first.apply(P1, ROOT_A, 'approval:k2-apply')).rejects.toThrow(/simulated process exit after/)
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
      target,
      baselineSha256: sha256Of(skillText(V0, SKILL)),
      contentSha256: sha256Of(skillText(V1, SKILL)),
      source: `sandbox/${P1}/skills/${SKILL}/SKILL.md`,
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

    const crash = crashProbe()
    const first = evolutionOf(h1, crash.probe)
    await walkToDecided(h1, first, P1, SKILL, skillText(V1, SKILL))
    // A complete apply first: the state a rollback starts from, and the state it
    // must still find production in.
    await first.apply(P1, ROOT_A, 'approval:k2-apply')
    expect(await productionBytes(h1)).toBe(skillText(V1, SKILL))
    const applied = kindsOf(await ledgerLines(h1))
    expect(applied.slice(-2)).toEqual(['commit_intent', 'applied'])

    crash.arm(stage)
    await expect(first.rollback(P1, ROOT_A, 'approval:k2-rollback')).rejects.toThrow(/simulated process exit after/)
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
      target,
      baselineSha256: sha256Of(skillText(V1, SKILL)),
      contentSha256: sha256Of(skillText(V0, SKILL)),
      source: `sandbox/${P1}/champion/skills/${SKILL}/SKILL.md`,
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

describe('K2-3: an open commit intent blocks the real admission until a reconciliation settles it', () => {
  it('refuses the gated capability by name with no evolution tool registered, and admits it again after the host reconciled', async () => {
    const directory = await sharedDirectory()
    const h1 = await startRunStack({ workspace: directory, roots: [ROOT_A], capabilities: { ...TABLE }, tools: true })
    await writeGuidanceSkill(join(h1.home, 'skills'), SKILL, V0)
    await writeGuidanceSkill(join(h1.home, 'skills'), CLEAN_SKILL, V0)
    const target = productionPath(h1)

    // A commit interrupted after the rename: production already carries the new
    // version and the ledger says its completion was never recorded.
    const crash = crashProbe()
    const first = evolutionOf(h1, crash.probe)
    await walkToDecided(h1, first, P1, SKILL, skillText(V1, SKILL))
    crash.arm('write-renamed')
    await expect(first.apply(P1, ROOT_A, 'approval:k2-apply')).rejects.toThrow(/simulated process exit after/)
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

    const crash = crashProbe()
    const first = evolutionOf(h1, crash.probe)
    await walkToDecided(h1, first, P1, SKILL, skillText(V1, SKILL))
    crash.arm('intent-recorded')
    await expect(first.apply(P1, ROOT_A, 'approval:k2-apply')).rejects.toThrow(/simulated process exit after/)
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
    expect(warnings.join('\n')).toContain('a third party changed it')

    // Named blocked, with production exactly as the third party left it, the intent
    // still open and no line written.
    const outcomes = await reopened.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ intentId: `${P1}/apply`, proposalId: P1, direction: 'apply', target, result: 'blocked' })
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
})

describe('K2-5: a reopened instance rolls an applied proposal back through the real tool', () => {
  it('rolls back over a formatVersion 3 ledger the reopened process read from disk', async () => {
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
    const h2 = await startRunStack({ workspace: directory, roots: [ROOT_A], capabilities: { ...TABLE }, tools: true })
    const reopened = evolutionOf(h2)
    const lines = await ledgerLines(h2)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every(line => line.formatVersion === 3)).toBe(true)
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
    expect(settled.every(line => line.formatVersion === 3)).toBe(true)
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

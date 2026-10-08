import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { rootTaskStoreId } from '../../task/src/index.ts'
import { SKILL_SIDECAR_FILE, serializeSkillSidecar } from '../../task-runtime/src/index.ts'
import type { CommitStage } from '../../evolution/src/commit.ts'
import { sha256Of, type RunStack } from '../support/run-stack.ts'
import {
  type CommitWindow,
  SKILL,
  productionSkill,
  productionSidecar,
  GUIDE_ROW,
  CLEAN_SKILL,
  productionDirectory,
  type UnitStack,
  type InstalledSkill,
  boot,
  skillRoot,
  writeSkillObject,
  skillBody,
  ROOT_A,
  rootContract,
  writeSample,
  criterion,
  walkToGated,
  P2,
  decideThroughTool,
  applyThroughTool,
  APPLY_WINDOWS,
  sharedDirectory,
  decidedWorld,
  commitTargets,
  kindsOf,
  ledgerLines,
  productionObject,
  sideState,
  P1,
  intentFiles,
  interruptedState,
  stagedNow,
  assertInterruptedState,
  ROOT_B,
  ROW,
  captureWarnings,
  settledComplete,
  admitChild,
  boundObject,
  bindingOf,
  ROLLBACK_WINDOWS,
  ledgerBytes,
  derivedSidecar,
  stagingFiles,
  windowProbe,
} from './k3-skill-unit.fixture.ts'

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

/* ------------------------------------------------------------------------- *
 * K3-4 — the directory a rollback writes
 * ------------------------------------------------------------------------- */

/**
 * The declaration a third party drops beside a guidance object: a *valid*
 * execution declaration (the row grants it, the registered `command` verifier
 * judges it, it declares no resource) whose `content.skillMdSha256` is the digest
 * of the body production actually holds — so the declaration is internally
 * consistent, and the only thing wrong with the directory is that it carries a
 * declaration the guidance object the apply installed never named.
 */
function executionDriftDeclaration(heldSha256: string): Record<string, unknown> {
  return {
    contractVersion: 1,
    type: 'execution',
    capabilities: [GUIDE_ROW],
    precondition: 'a third party declared an execution provider while the object was applied',
    inputs: [],
    outputs: [],
    requiredTools: [],
    verifier: { ref: 'command' },
    content: { skillMdSha256: heldSha256, resources: [] },
  }
}

/**
 * The two shapes a third party leaves in the directory a guidance rollback would
 * write: an execution declaration beside the object (a role drift, which makes the
 * directory a different object than the guidance one the apply installed) and a
 * file at a supported resource position (an entry the applied object's own
 * identity does not name). Both refuse the rollback by the whole-object identity
 * check, before any write, with the message `refusal` names.
 */
const DIRECTORY_DRIFT: readonly {
  readonly label: string
  /** The entry the third party added — the file the refusal has to leave untouched. */
  readonly entry: string
  /** The message the whole-object identity check reports for this shape. */
  readonly refusal: string
  add(h: RunStack, heldSha256: string): Promise<void>
}[] = [
  {
    label: 'an execution declaration beside the guidance object',
    entry: SKILL_SIDECAR_FILE,
    refusal: 'no longer matches its frozen content identity',
    add: async (h, heldSha256) => {
      await writeFile(
        productionSidecar(h, CLEAN_SKILL),
        serializeSkillSidecar(executionDriftDeclaration(heldSha256) as never),
        'utf8',
      )
    },
  },
  {
    label: 'a file at a supported resource position',
    entry: 'references/notes.md',
    refusal: 'no longer matches its frozen content identity',
    add: async h => {
      await mkdir(join(productionDirectory(h, CLEAN_SKILL), 'references'), { recursive: true })
      await writeFile(
        join(productionDirectory(h, CLEAN_SKILL), 'references', 'notes.md'),
        'a reference the object never declared\n',
        'utf8',
      )
    },
  },
]

/**
 * The world both cases below start from: one guidance object in production, one
 * proposal walked to `applied` through the real tools, and production holding the
 * candidate body — `guidance.skillMd` is the champion body a rollback restores.
 */
async function appliedGuidanceWorld(
  options: { commitProbe?: (stage: CommitStage, target?: string) => void } = {},
): Promise<{
  s: UnitStack
  guidance: InstalledSkill
  candidateBody: string
}> {
  const s = await boot({ ...options })
  const h = s.h
  const guidance = await writeSkillObject(skillRoot(h), {
    name: CLEAN_SKILL,
    body: skillBody(CLEAN_SKILL, ['keep.txt', 'holdout.txt']),
  })
  const root = await h.root(ROOT_A, rootContract('evaluate the candidate guidance skill'))
  await writeSample(h, root.storeId, {
    taskId: 't-fix',
    runId: 'r-fix-history',
    objective: 'the answer file is produced',
    acceptance: criterion('ac-fix', 'test -f fix.txt'),
    outcome: 'failed',
    capability: GUIDE_ROW,
  })
  await writeSample(h, root.storeId, {
    taskId: 't-holdout',
    runId: 'r-holdout-history',
    objective: 'the held-out answer file is produced',
    acceptance: criterion('ac-holdout', 'test -f holdout.txt'),
    outcome: 'verified',
    capability: GUIDE_ROW,
  })
  await mkdir(join(h.checkout, 'nested'), { recursive: true })
  const candidateBody = skillBody(CLEAN_SKILL, ['fix.txt', 'holdout.txt'])
  await walkToGated(s, {
    proposalId: P2,
    name: CLEAN_SKILL,
    content: candidateBody,
    samples: ['t-fix'],
    holdout: ['t-holdout'],
  })
  await decideThroughTool(s, P2)
  await applyThroughTool(s, P2)
  return { s, guidance, candidateBody }
}

/* ------------------------------------------------------------------------- *
 * K3-4 — the directory a two-file commit writes
 * ------------------------------------------------------------------------- */

/**
 * The entries a third party leaves in the directory an **execution** commit would
 * write. An execution object's declaration names every file it covers, so its
 * committed file set has to name every file in that directory back, and all three
 * shapes below are entries the declared identity does not cover: a file at a
 * supported resource position the declaration never listed, an entry the
 * supported vocabulary does not cover at all, and a staging file whose prefix
 * belongs to no target of this object.
 *
 * The whole-object check that refuses them is the production baseline check: the
 * directory a commit would write must still be the loadable object `prepare`
 * froze, so an entry outside its declared identity refuses the commit before the
 * intent line — the *own*-target staging leftover included
 * (`evolution/tests/unit/commit-durability.spec.ts` pins the same shape). The
 * staging tolerance lives in the recovery path, where the settle runs
 * `objectWriteRefusal` over the directory a dead attempt left behind.
 *
 * `named` is the fragment the refusal has to carry. The loader reports the entry
 * it read, so the resource shape is named as the file inside `references/` and
 * the direct entry as its own name.
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
    named: 'references/notes.md',
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
    note: 'this object has no "other.md", so its prefix is nobody\'s leftover and no commit of this object covers it',
  },
]

/** Write one externally added entry under the skill directory of a two-file world. */
async function addExecutionEntry(h: RunStack, entry: string): Promise<void> {
  const at = join(productionDirectory(h), entry)
  await mkdir(dirname(at), { recursive: true })
  await writeFile(at, `${entry} was added from outside this ledger\n`, 'utf8')
}

describe('K3-4: a two-file commit interrupted between two durable writes is settled by the process that reopens the directory', () => {
  it.each(APPLY_WINDOWS)(
    'settles an apply interrupted after $label, and the reopened host lands both files',
    async window => {
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
      expect(intent).toMatchObject({
        kind: 'commit_intent',
        intentId: `${P1}/apply`,
        proposalId: P1,
        direction: 'apply',
        approvalRef: 'approval:k3-apply',
      })
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
      // ledger and both production files off disk. Booting *is* this deployment's
      // recovery entry — the process reconciles this graph's ledger before the
      // graph's evolution plane is opened over it — so this process image is what
      // settles the commit the interrupted one left open.
      // The first boot hands its checkout back — settling the tree it activated is
      // what releases the claim a second process image would otherwise find busy.
      await h.runtime.submitResult(ROOT_A, { summary: 'the first boot hands its checkout back' })

      const reopened = await boot({ workspace: directory, graphRootFor: () => ROOT_A })
      const h2 = reopened.h
      expect(await reopened.svc.openIntentTargets()).toEqual([])
      expect(await productionObject(h2)).toEqual(sideState(world, 'candidate'))

      // The barrier a restart runs before it takes a store over finds nothing left
      // to settle: this image's own boot already closed the commit.
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
      expect(await boundObject(await bindingOf(h2, root.storeId, admitted.childRunId))).toEqual(
        sideState(world, 'candidate'),
      )
      await h2.runtime.submitResult(ROOT_A, { summary: 'the tree hands in the result its batch produced' })
    },
    180_000,
  )

  it.each(ROLLBACK_WINDOWS)(
    'settles a rollback interrupted after $label, and the reopened host restores both files',
    async window => {
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
      await expect(world.s.svc.rollback(P1, ROOT_A, 'approval:k3-rollback')).rejects.toThrow(
        /in-process probe threw after/,
      )
      const fired = world.probe.fired.at(-1)!
      expect(fired.stage).toBe(window.stage)
      expect(fired.target).toBe(armed)

      const interrupted = await ledgerLines(h)
      expect(kindsOf(interrupted)).toEqual([...applied, 'commit_intent'])
      const intent = interrupted.at(-1)!
      expect(intent).toMatchObject({
        kind: 'commit_intent',
        intentId: `${P1}/rollback`,
        direction: 'rollback',
        approvalRef: 'approval:k3-rollback',
      })
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
      const reopened = await boot({ workspace: directory, graphRootFor: () => ROOT_A })
      const h2 = reopened.h
      expect(await reopened.svc.openIntentTargets()).toEqual([])
      expect(await productionObject(h2)).toEqual(sideState(world, 'production'))

      const adoptedStore = rootTaskStoreId(ROOT_A)
      await h2.task.createStore(adoptedStore)
      const warnings = captureWarnings(h2)
      const adoption = await h2.runtime.adoptRoot(adoptedStore, ROOT_A)
      expect(adoption.adopted).toBe(false)
      expect(warnings.filter(line => line.includes('could not be settled'))).toEqual([])

      await settledComplete({
        reopened,
        direction: 'rollback',
        intent,
        walked: applied,
        target: sideState(world, 'production'),
      })

      const root = await h2.root(ROOT_A, rootContract('ship the restored release'))
      const admitted = await admitChild(h2, ROOT_A, root)
      expect(await boundObject(await bindingOf(h2, root.storeId, admitted.childRunId))).toEqual(
        sideState(world, 'production'),
      )
      await h2.runtime.submitResult(ROOT_A, { summary: 'the tree hands in the result its batch produced' })
    },
    180_000,
  )

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
    const thirdParty = serializeSkillSidecar({
      ...(JSON.parse(world.production.sidecar!) as Record<string, unknown>),
      precondition: 'a third party rewrote the declaration',
    } as never)
    await writeFile(productionSidecar(h), thirdParty, 'utf8')

    const reopened = await boot({ workspace: directory, graphRootFor: () => ROOT_A })
    const h2 = reopened.h
    expect(await reopened.svc.openIntentTargets()).toEqual(targets)

    const adoptedStore = rootTaskStoreId(ROOT_A)
    await h2.task.createStore(adoptedStore)
    // The barrier is the recovery entry that reports the block: it reconciles the
    // ledger through the instance this context holds (`ctx.evolution`), rooted at
    // this graph's library, and finds an intent it may not settle — named with its
    // targets and the reason it stayed open. A blocked intent does not fail the
    // takeover.
    const warnings = captureWarnings(h2)
    expect((await h2.runtime.adoptRoot(adoptedStore, ROOT_A)).adopted).toBe(false)
    expect(warnings.join('\n')).toContain(`${P1}/apply`)
    expect(warnings.join('\n')).toContain('could not be settled')
    expect(warnings.join('\n')).toContain('a third party changed it')

    // The same block, on the graph's own reconcile entry a caller re-reads: the
    // intent, its targets, and the reason a blocked commit stayed open.
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
    await expect(h2.root(ROOT_B, rootContract('ship the tampered release', [ROW]))).rejects.toThrow(
      /commit-intent-open/,
    )
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
    // production no longer holds the object it was prepared against.
    const stale = await world.s.call('evolution_apply', { proposalId: P2 })
    expect(stale.text).toContain('no longer matches its frozen content identity')
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
    expect(intentFiles(landed.filter(line => line.kind === 'commit_intent').at(-1)!).map(file => file.target)).toEqual(
      targets,
    )
    expect(await world.s.svc.openIntentTargets()).toEqual([])
  }, 240_000)
})

describe('K3-4: a rollback refuses a directory holding entries the committed object does not name, before anything is written', () => {
  it.each(DIRECTORY_DRIFT)(
    'refuses a fresh rollback of a directory that now holds $label, writing nothing',
    async ({ entry, refusal, add }) => {
      const { s, candidateBody } = await appliedGuidanceWorld()
      const h = s.h
      const target = productionSkill(h, CLEAN_SKILL)
      // The apply landed, whole: one guidance file, no declaration beside it.
      expect(await productionObject(h, CLEAN_SKILL)).toEqual({ skillMd: candidateBody })

      // A third party adds an entry the object the apply installed does not name —
      // after the apply, so nothing that ran before this write saw it. The
      // declaration this shape adds is internally consistent with the bytes
      // production holds, so the only thing wrong with the directory is the entry.
      await add(h, sha256Of(candidateBody))

      const before = await ledgerBytes(h)
      const productionBefore = await productionObject(h, CLEAN_SKILL)
      const driftedPath = join(productionDirectory(h, CLEAN_SKILL), entry)
      const driftedBytes = await readFile(driftedPath, 'utf8')
      const refused = await s.svc.rollback(P2, ROOT_A, 'approval:k3-rollback').then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )

      // The whole-object identity check refuses the directory *before* the write:
      // production is not the guidance object the apply installed any more, so
      // nothing was written, no second intent was recorded, and the proposal is
      // still applied. The message carries what production and the ledger hold
      // instead, so a refusal that arrived after the write cannot read as a pass.
      const afterRefusal = await productionObject(h, CLEAN_SKILL)
      expect(
        refused,
        `the rollback must refuse before it writes anything — production now holds ${JSON.stringify(afterRefusal)} and the ledger ends with ` +
          `${JSON.stringify(kindsOf(await ledgerLines(h)).slice(-2))}`,
      ).toContain(refusal)
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
    },
    180_000,
  )

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
    await writeFile(
      productionSidecar(h, CLEAN_SKILL),
      serializeSkillSidecar(executionDriftDeclaration(guidance.skillMdSha256) as never),
      'utf8',
    )
    const drifted = await productionObject(h, CLEAN_SKILL)

    // The retry settles the open intent, and the settlement refuses by name
    // before it writes: the recovery entry is a blocked outcome, not a write.
    const retry = await s.svc.rollback(P2, ROOT_A, 'approval:k3-rollback').then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
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

describe('K3-4: a two-file commit refuses a production directory holding entries the execution object does not name, before anything is written', () => {
  it.each(EXECUTION_DIRECTORY_DRIFT)(
    'refuses the apply when the directory holds $label, writing nothing',
    async ({ entry, named, note }) => {
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
      const refused = await world.s.svc.apply(P1, ROOT_A, 'approval:k3-apply').then(
        () => '',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      )
      const afterRefusal = await productionObject(h)
      expect(
        refused,
        `the apply must refuse before it writes anything (${note}) — production now holds ${JSON.stringify(afterRefusal)} and the ledger ` +
          `ends with ${JSON.stringify(kindsOf(await ledgerLines(h)).slice(-2))}`,
      ).toContain(named)
      // The production baseline check is what refuses it: the directory a commit
      // would write must still be the loadable object `prepare` froze.
      expect(refused).toContain('is not loadable')

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
    },
    180_000,
  )

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
    const refused = await world.s.svc.rollback(P1, ROOT_A, 'approval:k3-rollback').then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )
    const afterRefusal = await productionObject(h)
    expect(
      refused,
      `the rollback must refuse before it writes anything — production now holds ${JSON.stringify(afterRefusal)} and the ledger ends ` +
        `with ${JSON.stringify(kindsOf(await ledgerLines(h)).slice(-2))}`,
    ).toContain('references/notes.md')
    expect(refused).toContain('is not loadable')

    // The applied pair stands byte for byte, the directory still holds the
    // stranger's entry and nothing else changed, no rollback intent was recorded,
    // and the proposal is still applied.
    expect(await ledgerBytes(h)).toBe(before)
    expect(kindsOf(await ledgerLines(h)).filter(kind => kind === 'commit_intent')).toHaveLength(1)
    expect(await productionObject(h)).toEqual(productionBefore)
    expect((await readdir(productionDirectory(h))).sort()).toEqual(entriesBefore)
    expect(await readFile(join(productionDirectory(h), 'references', 'notes.md'), 'utf8')).toBe(
      'references/notes.md was added from outside this ledger\n',
    )
    expect(await world.s.svc.openIntentTargets()).toEqual([])
    expect((await world.s.svc.get(P1)).status).toBe('applied')
    expect(await readFile(targets[1], 'utf8')).toBe(world.derivedBytes)
  }, 180_000)

  it('refuses the commit when the only other entry is this object\u2019s own staging leftover, before anything is staged', async () => {
    const world = await decidedWorld(await sharedDirectory())
    const h = world.s.h
    const stale = join(productionDirectory(h), '.SKILL.md.tmp-4242-deadbeef')
    await writeFile(stale, '# a staging file a killed attempt of this very target left behind\n', 'utf8')
    const production = await productionObject(h)
    const before = await ledgerBytes(h)

    const refused = await world.s.svc.apply(P1, ROOT_A, 'approval:k3-apply').then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    )

    // Even this object's *own* staging prefix is an entry the declared identity does
    // not cover, so the production baseline check refuses the directory before the
    // commit stages anything. The tolerance for a dead attempt's own leftover
    // belongs to the recovery path — `objectWriteRefusal` over the directory a
    // settlement finds — and not to a fresh commit.
    expect(refused).toContain('is not loadable')
    expect(refused).toContain('.SKILL.md.tmp-4242-deadbeef')

    // Nothing moved: both production files are the bytes they were, the leftover
    // still stands (a refusal removes nothing), no line was recorded and the
    // proposal is still decided.
    expect(await productionObject(h)).toEqual(production)
    expect(existsSync(stale)).toBe(true)
    expect(await readFile(stale, 'utf8')).toBe('# a staging file a killed attempt of this very target left behind\n')
    expect(await ledgerBytes(h)).toBe(before)
    expect(await stagedNow(h)).toEqual(['.SKILL.md.tmp-4242-deadbeef'])
    expect(await world.s.svc.openIntentTargets()).toEqual([])
    expect((await world.s.svc.get(P1)).status).toBe('decided')
  }, 180_000)
})

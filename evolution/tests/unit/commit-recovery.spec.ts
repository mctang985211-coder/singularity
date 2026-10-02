import { chmod, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EvolutionService } from '../../src/evolution.ts'
import type { Config } from '../../src/evolution.ts'
import type { CommitStage } from '../../src/commit.ts'
import {
  SKILL_CANDIDATE,
  productionSkill,
  fixtureCtx,
  FIXTURE_SELECTION,
  walkToDecided,
  skillProposal,
  reopenLike,
  ledgerFixture,
  decidedLines,
  appliedLine,
  intentLine,
  intentFile,
  FORGED_INTENT,
  FORGED_TARGET,
  COMMIT_TARGET,
  ledgerKinds,
  ledgerLinesOf,
  sha256Of,
  P3_BASELINE,
  CANDIDATE_SOURCE,
  CHAMPION_SOURCE,
  serviceWithProduction,
  walkSkillToDecided,
  P3_CANDIDATE_A,
  P3_CANDIDATE_B,
  skillProductionFile,
  refusalOf,
  INTERRUPTED_STAGES,
} from './evolution.fixture.ts'

/**
 * The service config that stops one commit at `stage` — the typed test seam, and
 * only that: the probe throws an ordinary in-process error, which aborts the
 * commit exactly where it stands (no later stage of the commit runs). It is a
 * window-injection seam, **not** a process exit, and it proves nothing about
 * process exits: `writeFileAtomic`'s own `catch` still runs here and removes the
 * staging file it had written. The process-exit evidence is the real-SIGKILL
 * cases of `tests/integration/k2-evolution-commit.spec.ts`; what a durable
 * operation does when it fails is `commit-durability.spec.ts`.
 */
function crashAt(stage: CommitStage): Pick<Config, 'commitProbe'> {
  return {
    commitProbe: seen => {
      if (seen === stage) throw new Error(`in-process probe throw after ${seen} — a throw, not a process exit`)
    },
  }
}

/**
 * A production fixture walked to decided(PROMOTE): production holds the
 * champion, the sandbox holds the candidate, its champion snapshot and a
 * completed experiment. `probe` opens an interrupt window on that service — an
 * in-process throw at one stage, not a process exit (see {@link crashAt}).
 */
async function decidedSkillFixture(candidate: string = SKILL_CANDIDATE, probe?: CommitStage) {
  const dir = await mkdtemp(join(tmpdir(), 'evolution-commit-'))
  const root = join(dir, 'evolution')
  const skillRoot = join(dir, 'skills')
  await productionSkill(skillRoot)
  const svc = new EvolutionService(fixtureCtx(), {
    modelSelection: () => FIXTURE_SELECTION,
    root,
    skillRoot,
    ...(probe === undefined ? {} : crashAt(probe)),
  })
  await walkToDecided(svc, skillProposal, { name: 'verify', content: candidate })
  return { svc, dir, root, skillRoot }
}

/** A second service over the same ledger, store rows and roots, with an interrupt window of its own. */
function reopenWithProbe(
  svc: EvolutionService,
  roots: { root: string; skillRoot: string },
  probe?: CommitStage,
): EvolutionService {
  return reopenLike(svc, {
    modelSelection: () => FIXTURE_SELECTION,
    root: roots.root,
    skillRoot: roots.skillRoot,
    ...(probe === undefined ? {} : crashAt(probe)),
  })
}

describe('K2: commit intents in the fold', () => {
  it('refuses a completion that closes no open intent, naming what it would have closed', async () => {
    const { svc, root } = await ledgerFixture(decidedLines([appliedLine()]))
    const err = await svc.list().then(
      () => undefined,
      (error: Error) => error,
    )
    expect(String((err as Error).message)).toMatch(/closes no open commit intent/)
    // Refused at load: the bytes stay exactly as written, and a second instance
    // reaches the same verdict.
    expect((await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(6)
    await expect(
      reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot: svc.skillRoot }).list(),
    ).rejects.toThrow(/closes no open commit intent/)
  })

  it('refuses a completion that carries no intentId at all', async () => {
    const withoutIntentId = { ...appliedLine() }
    delete withoutIntentId.intentId
    const { svc } = await ledgerFixture(decidedLines([intentLine(), withoutIntentId]))
    await expect(svc.list()).rejects.toThrow(/names no commit intent/)
  })

  it.each([
    ['another intent id', appliedLine({ intentId: 's1/apply-again' }), /but the open intent of that proposal is/],
    ['another approval', appliedLine({ approvalRef: 'approval:somebody-else' }), /not the approval the open intent/],
    [
      'another target',
      appliedLine({ targets: ['/production/skills/other/SKILL.md'] }),
      /but the open intent .* commits/,
    ],
  ])('refuses a completion that closes its intent with %s', async (_label, line, expected) => {
    const { svc } = await ledgerFixture(decidedLines([intentLine(), line]))
    await expect(svc.list()).rejects.toThrow(expected as RegExp)
  })

  it('refuses a rolledback record that closes no open intent — the apply completion already closed it', async () => {
    const { svc } = await ledgerFixture(
      decidedLines([
        intentLine(),
        appliedLine(),
        { ...appliedLine(), kind: 'rolledback', intentId: 's1/rollback', at: '2026-09-26T00:00:07.000Z' },
      ]),
    )
    await expect(svc.list()).rejects.toThrow(/closes no open commit intent/)
  })

  it('refuses a second open intent for one proposal, whatever it names', async () => {
    const { svc } = await ledgerFixture(decidedLines([intentLine(), intentLine({ at: '2026-09-26T00:00:07.000Z' })]))
    await expect(svc.list()).rejects.toThrow(/already has the open commit intent "s1\/apply"/)
  })

  it('refuses an intent id that is not derived from the proposal and direction', async () => {
    const { svc } = await ledgerFixture(decidedLines([intentLine({ intentId: 's1' })]))
    await expect(svc.list()).rejects.toThrow(/an intent's id is "<proposalId>\/<direction>"/)
  })

  it.each([
    ['apply', 'decided', ['proposed', 'candidate', 'prepared', 'gated'], /needs proposal "s1" to be decided/],
    [
      'rollback',
      'applied',
      ['proposed', 'candidate', 'prepared', 'gated', 'decided'],
      /needs proposal "s1" to be applied/,
    ],
  ] as const)('requires the state a %s intent commits (%s)', async (direction, _state, kinds, expected) => {
    const lines = decidedLines().slice(0, kinds.length)
    const intent =
      direction === 'apply'
        ? intentLine({ at: '2026-09-26T00:00:05.000Z' })
        : intentLine({ intentId: 's1/rollback', direction: 'rollback', at: '2026-09-26T00:00:05.000Z' })
    const { svc } = await ledgerFixture([...lines, intent])
    await expect(svc.list()).rejects.toThrow(expected as RegExp)
  })

  it.each([
    ['no source', { files: [{ ...intentFile(), source: undefined }] }, /file 0 has no source/],
    [
      'a digest that is not a digest',
      { files: [{ ...intentFile(), baselineSha256: 'not-a-digest' }] },
      /file 0 has no valid baselineSha256/,
    ],
    ['a direction this build has no commit for', { direction: 'revert' }, /declares direction "revert"/],
    [
      'a relative target',
      { files: [{ ...intentFile(), target: 'skills/verify/SKILL.md' }] },
      /an intent names the absolute production paths/,
    ],
    [
      'a file that is not the object',
      { files: [{ ...intentFile(), target: '/production/skills/verify/README.md' }] },
      /the file set of one skill object is ordered and fixed/,
    ],
    [
      'a sidecar of another directory',
      { files: [intentFile(), { ...intentFile(), target: '/production/skills/other/SKILL.contract.json' }] },
      /the files of one skill object live in one directory/,
    ],
    ['three files', { files: [intentFile(), intentFile(), intentFile()] }, /a fixed file set of one or two files/],
    ['no file list at all', { files: [] }, /a fixed file set of one or two files/],
  ])('refuses a commit intent with %s', async (_label, over, expected) => {
    const { svc } = await ledgerFixture(decidedLines([intentLine(over)]))
    await expect(svc.list()).rejects.toThrow(expected as RegExp)
  })

  it("folds an open intent back as the proposal's own openIntent, and clears it at the completion", async () => {
    const open = await ledgerFixture(decidedLines([intentLine()]))
    const proposal = await open.svc.get('s1')
    expect(proposal.status).toBe('decided')
    expect(proposal.openIntent).toEqual({
      intentId: FORGED_INTENT,
      proposalId: 's1',
      direction: 'apply',
      approvalRef: 'approval:decide',
      files: [intentFile()],
      actor: 'root-1',
      at: '2026-09-26T00:00:05.000Z',
    })
    // A commit intent is not a lifecycle transition: the history is the one the
    // lifecycle records wrote.
    expect(proposal.history.map(entry => entry.status)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'gated',
      'decided',
    ])
    expect((await open.svc.list())[0]!.openIntent?.intentId).toBe(FORGED_INTENT)
    expect(await open.svc.openIntentTargets()).toEqual([FORGED_TARGET])

    const closed = await ledgerFixture(decidedLines([intentLine(), appliedLine()]))
    const settled = await closed.svc.get('s1')
    expect(settled.status).toBe('applied')
    expect(settled.openIntent).toBeUndefined()
    expect(settled.applied).toEqual({ targets: [FORGED_TARGET], approvalRef: 'approval:decide' })
    expect(await closed.svc.openIntentTargets()).toEqual([])
  })
})

describe('K2: the commit — intent, atomic write, completion', () => {
  it('applies through one commit: the intent line precedes the applied line, and production carries the verified candidate', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const outcome = await svc.apply('s1', 'root-1', 'approval:call-1')
    const target = COMMIT_TARGET(skillRoot)

    expect(outcome.recovered).toBeUndefined()
    expect(outcome.targets).toEqual([target])
    expect(await readFile(target)).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    expect(await ledgerKinds(root)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'experiment_started',
      'experiment_sample',
      'experiment_sample',
      'experiment_sample',
      'experiment_sample',
      'gated',
      'decided',
      'commit_intent',
      'applied',
    ])
    const intent = (await ledgerLinesOf(root)).find(line => line.kind === 'commit_intent')!
    expect(intent).toMatchObject({
      intentId: 's1/apply',
      proposalId: 's1',
      direction: 'apply',
      approvalRef: 'approval:call-1',
      files: [
        {
          target,
          baselineSha256: sha256Of(P3_BASELINE),
          contentSha256: sha256Of(SKILL_CANDIDATE),
          source: CANDIDATE_SOURCE,
        },
      ],
      actor: 'root-1',
    })
    const applied = (await ledgerLinesOf(root)).find(line => line.kind === 'applied')!
    expect(applied).toMatchObject({ intentId: 's1/apply', targets: [target], approvalRef: 'approval:call-1' })
    expect((await svc.get('s1')).status).toBe('applied')
    expect((await svc.get('s1')).openIntent).toBeUndefined()
    expect(await svc.openIntentTargets()).toEqual([])
    // The commit stages its bytes beside the target and renames them over it:
    // nothing of the staging file survives a successful commit.
    expect((await readdir(join(skillRoot, 'verify'))).filter(entry => entry.includes('.tmp-'))).toEqual([])
  })

  it('rolls back through one commit: the intent names the applied content as the baseline and the snapshot as the content', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const outcome = await svc.rollback('s1', 'root-1', 'approval:call-2')
    const target = COMMIT_TARGET(skillRoot)

    expect(outcome.recovered).toBeUndefined()
    expect(await readFile(target)).toEqual(Buffer.from(P3_BASELINE, 'utf8'))
    expect((await ledgerKinds(root)).slice(-4)).toEqual(['commit_intent', 'applied', 'commit_intent', 'rolledback'])
    const intents = (await ledgerLinesOf(root)).filter(line => line.kind === 'commit_intent')
    expect(intents[1]).toMatchObject({
      intentId: 's1/rollback',
      direction: 'rollback',
      approvalRef: 'approval:call-2',
      files: [
        {
          target,
          baselineSha256: sha256Of(SKILL_CANDIDATE),
          contentSha256: sha256Of(P3_BASELINE),
          source: CHAMPION_SOURCE,
        },
      ],
    })
    expect((await ledgerLinesOf(root)).find(line => line.kind === 'rolledback')).toMatchObject({
      intentId: 's1/rollback',
      targets: [target],
      approvalRef: 'approval:call-2',
    })
  })

  it('refuses a rollback whose target no longer holds what the proposal applied, before any intent is recorded', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await writeFile(COMMIT_TARGET(skillRoot), '# a later writer moved this target\n')

    await expect(svc.rollback('s1', 'root-1', 'approval:call-2')).rejects.toThrow(
      /does not hold the content proposal "s1" applied/,
    )
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe('# a later writer moved this target\n')
    expect(await svc.openIntentTargets()).toEqual([])
  })

  it('refuses a rollback whose champion snapshot no longer hashes to the recorded baseline, before any intent is recorded', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await writeFile(join(root, CHAMPION_SOURCE), '# the snapshot was damaged\n')

    await expect(svc.rollback('s1', 'root-1', 'approval:call-2')).rejects.toThrow(
      /champion snapshot .* no longer hashes/,
    )
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(await readFile(COMMIT_TARGET(skillRoot))).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    expect(await svc.openIntentTargets()).toEqual([])
  })

  it('refuses to roll an earlier proposal back over a later one that changed the same target', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)
    await svc.apply('s1', 'root-1', 'approval:call-1')
    // The second candidate is prepared against what the first one applied.
    await walkSkillToDecided(svc, 's2', P3_CANDIDATE_B)
    await svc.apply('s2', 'root-1', 'approval:call-2')
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(P3_CANDIDATE_B)

    // s1's rollback would restore a baseline on top of a version newer than the
    // one it is undoing: it stops by name, writes nothing and records no intent.
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await expect(svc.rollback('s1', 'root-1', 'approval:call-3')).rejects.toThrow(
      /does not hold the content proposal "s1" applied/,
    )
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(P3_CANDIDATE_B)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('s1')).status).toBe('applied')
    expect(await svc.openIntentTargets()).toEqual([])

    // The later proposal's own rollback restores exactly what it applied over.
    await svc.rollback('s2', 'root-1', 'approval:call-4')
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(P3_CANDIDATE_A)
    expect((await svc.get('s2')).status).toBe('rolledback')
  })

  it('refuses a drifted production baseline in the commit path, recording no intent', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    await writeFile(COMMIT_TARGET(skillRoot), '# moved since prepare\n')
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')

    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow(/changed since prepare/)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await svc.openIntentTargets()).toEqual([])
  })

  it("refuses a second apply on a target another proposal's open intent names, and admits one once that intent is settled", async () => {
    const fixture = await decidedSkillFixture(P3_CANDIDATE_A)
    const { svc, root, skillRoot } = fixture
    const target = COMMIT_TARGET(skillRoot)
    // s2 is prepared against the bytes s1 recorded as the baseline: its own
    // baseline check cannot see s1's unfinished commit, only the open intent can.
    await walkSkillToDecided(svc, 's2', P3_CANDIDATE_B)
    const baselineSha256 = sha256Of(P3_BASELINE)
    expect((await svc.get('s1')).prepared!.skillBaseline!.sha256).toBe(baselineSha256)
    expect((await svc.get('s2')).prepared!.skillBaseline!.sha256).toBe(baselineSha256)

    const crashing = reopenWithProbe(svc, fixture, 'intent-recorded')
    expect(await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))).toContain(
      'in-process probe throw after intent-recorded',
    )
    const reopened = reopenWithProbe(svc, fixture)
    const interrupted = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    expect(await readFile(target)).toEqual(Buffer.from(P3_BASELINE, 'utf8'))
    expect((await ledgerKinds(root)).at(-1)).toBe('commit_intent')
    expect(await reopened.openIntentTargets()).toEqual([target])
    expect((await reopened.get('s1')).openIntent?.intentId).toBe('s1/apply')

    // The second commit is refused by name, before it reads or moves anything.
    const refusal = await refusalOf(reopened.apply('s2', 'root-1', 'approval:call-2'))
    expect(refusal).toContain("another proposal's unsettled intent")
    expect(refusal).toContain(dirname(target))
    expect(refusal).toContain('s1/apply')
    expect(refusal).toContain('"s1"')
    expect(refusal).toContain('nothing was written and no commit intent was recorded')
    expect(await readFile(target)).toEqual(Buffer.from(P3_BASELINE, 'utf8'))
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(interrupted)
    expect((await reopened.get('s2')).status).toBe('decided')
    expect((await reopened.get('s2')).openIntent).toBeUndefined()
    expect((await reopened.get('s1')).openIntent?.intentId).toBe('s1/apply')

    // Settling s1's intent from what production holds admits commits again.
    expect((await reopened.reconcile()).map(outcome => outcome.result)).toEqual(['completed-redone'])
    expect(await readFile(target)).toEqual(Buffer.from(P3_CANDIDATE_A, 'utf8'))
    expect((await reopened.get('s1')).status).toBe('applied')
    expect(await reopened.openIntentTargets()).toEqual([])

    // s2's baseline is the pre-commit bytes: the ordinary check still refuses it.
    const settled = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    expect(await refusalOf(reopened.apply('s2', 'root-1', 'approval:call-2'))).toContain('changed since prepare')
    expect(await readFile(target)).toEqual(Buffer.from(P3_CANDIDATE_A, 'utf8'))
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(settled)

    // A proposal prepared against the recovered production commits normally.
    await walkSkillToDecided(reopened, 's3', P3_CANDIDATE_B)
    const outcome = await reopened.apply('s3', 'root-1', 'approval:call-3')
    expect(outcome.targets).toEqual([target])
    expect(await readFile(target)).toEqual(Buffer.from(P3_CANDIDATE_B, 'utf8'))
    expect((await reopened.get('s3')).status).toBe('applied')
  })

  it("refuses a rollback on a target another proposal's open intent names, leaving production and the ledger untouched", async () => {
    const fixture = await decidedSkillFixture(P3_CANDIDATE_A)
    const { svc, root, skillRoot } = fixture
    const target = COMMIT_TARGET(skillRoot)
    await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(await readFile(target)).toEqual(Buffer.from(P3_CANDIDATE_A, 'utf8'))
    // s2 is prepared against what s1 applied; its unfinished apply is what stands
    // between s1's rollback and the target.
    await walkSkillToDecided(svc, 's2', P3_CANDIDATE_B)

    const crashing = reopenWithProbe(svc, fixture, 'intent-recorded')
    expect(await refusalOf(crashing.apply('s2', 'root-1', 'approval:call-2'))).toContain(
      'in-process probe throw after intent-recorded',
    )
    const reopened = reopenWithProbe(svc, fixture)
    const interrupted = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    expect(await readFile(target)).toEqual(Buffer.from(P3_CANDIDATE_A, 'utf8'))
    expect((await reopened.get('s2')).openIntent?.intentId).toBe('s2/apply')
    expect(await reopened.openIntentTargets()).toEqual([target])

    const refusal = await refusalOf(reopened.rollback('s1', 'root-1', 'approval:call-3'))
    expect(refusal).toContain("another proposal's unsettled intent")
    expect(refusal).toContain(dirname(target))
    expect(refusal).toContain('s2/apply')
    expect(refusal).toContain('"s2"')
    expect(refusal).toContain('direction "apply"')
    expect(refusal).toContain('nothing was written and no commit intent was recorded')
    expect(await readFile(target)).toEqual(Buffer.from(P3_CANDIDATE_A, 'utf8'))
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(interrupted)
    expect((await reopened.get('s1')).status).toBe('applied')
    expect((await reopened.get('s1')).openIntent).toBeUndefined()
  })
})

describe('K2: recovery — an interruption between two durable writes leaves one open intent', () => {
  /** Walk one direction to the state a commit starts from, throw inside it at `stage`, and reopen. */
  async function interrupted(direction: 'apply' | 'rollback', stage: CommitStage) {
    const fixture = await decidedSkillFixture()
    if (direction === 'rollback') await fixture.svc.apply('s1', 'root-1', 'approval:call-1')
    const approval = direction === 'apply' ? 'approval:call-1' : 'approval:call-2'
    const crashing = reopenWithProbe(fixture.svc, fixture, stage)
    const message = await refusalOf(
      direction === 'apply' ? crashing.apply('s1', 'root-1', approval) : crashing.rollback('s1', 'root-1', approval),
    )
    expect(message).toContain(`in-process probe throw after ${stage}`)
    const reopened = reopenWithProbe(fixture.svc, fixture)
    return { ...fixture, reopened, approval }
  }

  it.each(INTERRUPTED_STAGES)('settles an apply interrupted after %s from production itself', async stage => {
    const { root, skillRoot, reopened } = await interrupted('apply', stage)
    const target = COMMIT_TARGET(skillRoot)
    // The ledger holds the intent and no completion; production holds the old
    // bytes except in the window where the rename already landed.
    const interruptedKinds = await ledgerKinds(root)
    expect(interruptedKinds.at(-1)).toBe('commit_intent')
    expect(interruptedKinds).not.toContain('applied')
    expect(await readFile(target, 'utf8')).toBe(stage === 'write-renamed' ? SKILL_CANDIDATE : P3_BASELINE)
    expect((await reopened.get('s1')).openIntent?.intentId).toBe('s1/apply')
    expect(await reopened.openIntentTargets()).toEqual([target])

    // A crash after the rename must not write production a second time.
    await utimes(target, new Date('2001-01-01T00:00:00.000Z'), new Date('2001-01-01T00:00:00.000Z'))
    const pinned = (await stat(target)).mtimeMs

    const outcomes = await reopened.reconcile()
    expect(outcomes).toEqual([
      {
        intentId: 's1/apply',
        proposalId: 's1',
        direction: 'apply',
        targets: [target],
        result: stage === 'write-renamed' ? 'completed-written' : 'completed-redone',
      },
    ])
    expect(await readFile(target)).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    if (stage === 'write-renamed') expect((await stat(target)).mtimeMs).toBe(pinned)
    else expect((await stat(target)).mtimeMs).not.toBe(pinned)

    // Exactly one completion row, the intent closed, and repeating the
    // reconciliation costs nothing.
    const settled = await ledgerKinds(root)
    expect(settled.filter(kind => kind === 'applied')).toHaveLength(1)
    expect(settled.filter(kind => kind === 'commit_intent')).toHaveLength(1)
    expect((await reopened.get('s1')).status).toBe('applied')
    expect((await reopened.get('s1')).openIntent).toBeUndefined()
    const bytes = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    expect(await reopened.reconcile()).toEqual([])
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(bytes)
  })

  it.each(INTERRUPTED_STAGES)('settles a rollback interrupted after %s from production itself', async stage => {
    const { root, skillRoot, reopened } = await interrupted('rollback', stage)
    const target = COMMIT_TARGET(skillRoot)
    const interruptedKinds = await ledgerKinds(root)
    expect(interruptedKinds.at(-1)).toBe('commit_intent')
    expect(interruptedKinds).not.toContain('rolledback')
    expect(await readFile(target, 'utf8')).toBe(stage === 'write-renamed' ? P3_BASELINE : SKILL_CANDIDATE)

    const outcomes = await reopened.reconcile()
    expect(outcomes).toEqual([
      {
        intentId: 's1/rollback',
        proposalId: 's1',
        direction: 'rollback',
        targets: [target],
        result: stage === 'write-renamed' ? 'completed-written' : 'completed-redone',
      },
    ])
    expect(await readFile(target)).toEqual(Buffer.from(P3_BASELINE, 'utf8'))
    const settled = await ledgerKinds(root)
    expect(settled.filter(kind => kind === 'rolledback')).toHaveLength(1)
    expect(settled.filter(kind => kind === 'commit_intent')).toHaveLength(2)
    expect((await reopened.get('s1')).status).toBe('rolledback')
    expect((await reopened.get('s1')).openIntent).toBeUndefined()
  })

  it('leaves a completed commit with nothing to settle: no open intent, no line, no write', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const reopened = reopenWithProbe(svc, { root, skillRoot })
    const bytes = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const target = COMMIT_TARGET(skillRoot)
    const mtime = (await stat(target)).mtimeMs

    expect(await reopened.openIntentTargets()).toEqual([])
    expect(await reopened.reconcile()).toEqual([])
    expect(await reopened.reconcile()).toEqual([])
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(bytes)
    expect((await stat(target)).mtimeMs).toBe(mtime)
  })

  it('does not read a leftover staging file as an applied result', async () => {
    const { root, skillRoot, reopened } = await interrupted('apply', 'write-staged')
    const target = COMMIT_TARGET(skillRoot)
    // A crash can leave the staged bytes beside the target; they are not the
    // result, and production — which still holds the old bytes — is what the
    // reconciliation reads.
    const staging = join(skillRoot, 'verify', '.SKILL.md.tmp-9999-deadbeef')
    await writeFile(staging, SKILL_CANDIDATE)

    const outcomes = await reopened.reconcile()
    expect(outcomes.map(outcome => outcome.result)).toEqual(['completed-redone'])
    expect(await readFile(target)).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
  })

  it('settles the recorded intent when apply is called again, without a second approval or a second commit', async () => {
    const { root, skillRoot, reopened } = await interrupted('apply', 'write-staged')
    const target = COMMIT_TARGET(skillRoot)

    const again = await reopened.apply('s1', 'root-1', 'approval:call-9')
    expect(again.recovered).toBe('redone')
    expect(again.targets).toEqual([target])
    expect(again.proposal.status).toBe('applied')
    expect(await readFile(target)).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    // The completion closes the intent with the grant the intent recorded, not
    // the one this retry passed.
    const applied = (await ledgerLinesOf(root)).filter(line => line.kind === 'applied')
    expect(applied).toHaveLength(1)
    expect(applied[0]).toMatchObject({ approvalRef: 'approval:call-1', intentId: 's1/apply' })
    expect((await ledgerKinds(root)).filter(kind => kind === 'commit_intent')).toHaveLength(1)
  })

  it('settles a rollback retry that finds the write already done, recording only the completion', async () => {
    const { root, skillRoot, reopened } = await interrupted('rollback', 'write-renamed')
    const target = COMMIT_TARGET(skillRoot)
    await utimes(target, new Date('2001-01-01T00:00:00.000Z'), new Date('2001-01-01T00:00:00.000Z'))
    const pinned = (await stat(target)).mtimeMs

    const again = await reopened.rollback('s1', 'root-1', 'approval:call-9')
    expect(again.recovered).toBe('written')
    expect(again.proposal.status).toBe('rolledback')
    expect((await stat(target)).mtimeMs).toBe(pinned)
    expect(await readFile(target)).toEqual(Buffer.from(P3_BASELINE, 'utf8'))
  })

  it('is exactly once: the retry that follows a settled commit is refused by the state machine and adds no line', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const crashing = reopenWithProbe(svc, { root, skillRoot }, 'intent-recorded')
    await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))
    const reopened = reopenWithProbe(svc, { root, skillRoot })
    expect((await reopened.reconcile()).map(outcome => outcome.result)).toEqual(['completed-redone'])

    const settled = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await expect(reopened.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow(
      'is applied; cannot record "applied"',
    )
    await expect(reopened.rollback('s1', 'root-1', 'approval:call-2')).resolves.toBeDefined()
    await expect(reopened.rollback('s1', 'root-1', 'approval:call-3')).rejects.toThrow(
      'is rolledback; cannot record "rolledback"',
    )
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).not.toBe(settled)
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
    expect((await ledgerKinds(root)).filter(kind => kind === 'rolledback')).toHaveLength(1)
  })
})

describe('K2: a source that is gone, or a target a third party touched, stops the commit by name', () => {
  it.each(['apply', 'rollback'] as const)(
    'blocks a %s whose target a third party rewrote, leaving the intent open and nothing written',
    async direction => {
      const fixture = await decidedSkillFixture()
      if (direction === 'rollback') await fixture.svc.apply('s1', 'root-1', 'approval:call-1')
      const { root, skillRoot } = fixture
      const crashing = reopenWithProbe(fixture.svc, fixture, 'intent-recorded')
      await refusalOf(
        direction === 'apply'
          ? crashing.apply('s1', 'root-1', 'approval:call-1')
          : crashing.rollback('s1', 'root-1', 'approval:call-2'),
      )
      const reopened = reopenWithProbe(fixture.svc, fixture)
      const target = COMMIT_TARGET(skillRoot)
      await writeFile(target, '# a third party rewrote production\n')
      const bytes = await readFile(join(root, 'proposals.jsonl'), 'utf8')

      const outcomes = await reopened.reconcile()
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]).toMatchObject({
        intentId: `s1/${direction}`,
        proposalId: 's1',
        direction,
        targets: [target],
        result: 'blocked',
      })
      expect(outcomes[0]!.detail).toMatch(/a third party changed it/)
      expect(outcomes[0]!.detail).toMatch(/the intent stays open/)
      expect(await readFile(target, 'utf8')).toBe('# a third party rewrote production\n')
      expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(bytes)
      // The intent is still there, so a loader that refuses while it is open keeps
      // refusing, and the retry that names it gets the same stop thrown.
      expect((await reopened.get('s1')).openIntent?.intentId).toBe(`s1/${direction}`)
      expect(await reopened.openIntentTargets()).toEqual([target])
      const retry =
        direction === 'apply'
          ? reopened.apply('s1', 'root-1', 'approval:call-1')
          : reopened.rollback('s1', 'root-1', 'approval:call-2')
      await expect(retry).rejects.toThrow(/a third party changed it/)
    },
  )

  it.each(['apply', 'rollback'] as const)('blocks a %s whose recoverable source is gone', async direction => {
    const fixture = await decidedSkillFixture()
    if (direction === 'rollback') await fixture.svc.apply('s1', 'root-1', 'approval:call-1')
    const { root } = fixture
    const crashing = reopenWithProbe(fixture.svc, fixture, 'intent-recorded')
    await refusalOf(
      direction === 'apply'
        ? crashing.apply('s1', 'root-1', 'approval:call-1')
        : crashing.rollback('s1', 'root-1', 'approval:call-2'),
    )
    const reopened = reopenWithProbe(fixture.svc, fixture)
    await rm(join(root, direction === 'apply' ? CANDIDATE_SOURCE : CHAMPION_SOURCE))
    const bytes = await readFile(join(root, 'proposals.jsonl'), 'utf8')

    const outcomes = await reopened.reconcile()
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ intentId: `s1/${direction}`, result: 'blocked' })
    expect(outcomes[0]!.detail).toMatch(/recoverable source .* is no longer readable as the bytes it committed/)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(bytes)
    expect((await reopened.get('s1')).openIntent?.intentId).toBe(`s1/${direction}`)
    await expect(reopened.reconcile()).resolves.toHaveLength(1)
  })

  it('blocks an intent whose production target disappeared', async () => {
    const { root, skillRoot, reopened } = await (async () => {
      const fixture = await decidedSkillFixture()
      const crashing = reopenWithProbe(fixture.svc, fixture, 'intent-recorded')
      await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))
      return { ...fixture, reopened: reopenWithProbe(fixture.svc, fixture) }
    })()
    const target = COMMIT_TARGET(skillRoot)
    await rm(target)

    const [outcome] = await reopened.reconcile()
    expect(outcome).toMatchObject({ result: 'blocked' })
    expect(outcome!.detail).toMatch(/is missing — it holds neither the state before the commit/)
    expect(existsSync(target)).toBe(false)
    expect(await ledgerKinds(root)).not.toContain('applied')
  })

  it('keeps the open-intent query pure: reading it neither writes nor settles anything', async () => {
    const fixture = await decidedSkillFixture()
    const { root, skillRoot } = fixture
    const crashing = reopenWithProbe(fixture.svc, fixture, 'intent-recorded')
    await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))
    const bytes = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const target = COMMIT_TARGET(skillRoot)

    const reopened = reopenWithProbe(fixture.svc, fixture)
    expect(await reopened.openIntentTargets()).toEqual([target])
    expect(await reopened.openIntentTargets()).toEqual([target])
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(bytes)
    expect(await readFile(target, 'utf8')).toBe(P3_BASELINE)
  })
})

describe('K2: a real write failure is not a mock — the intent stays open and reconciliation finishes the job', () => {
  it('throws on a target directory the process cannot write, records no completion, and completes once it can', async () => {
    const { svc, root, skillRoot } = await decidedSkillFixture()
    const target = COMMIT_TARGET(skillRoot)
    const directory = join(skillRoot, 'verify')
    await chmod(directory, 0o555)
    let message: string
    try {
      message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))
      expect(message).toMatch(/EACCES|permission denied/i)
      // The intent is the record of the attempt; the write failed, so there is
      // no completion, no change to production, and the open intent stands.
      expect(await ledgerKinds(root)).toContain('commit_intent')
      expect(await ledgerKinds(root)).not.toContain('applied')
      expect(await readFile(target, 'utf8')).toBe(P3_BASELINE)
      expect((await svc.get('s1')).openIntent?.intentId).toBe('s1/apply')
      expect(await svc.openIntentTargets()).toEqual([target])
    } finally {
      await chmod(directory, 0o755)
    }

    const outcomes = await svc.reconcile()
    expect(outcomes.map(outcome => outcome.result)).toEqual(['completed-redone'])
    expect(await readFile(target)).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
    expect((await svc.get('s1')).openIntent).toBeUndefined()
  })
})

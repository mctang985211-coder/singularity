import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SKILL_SIDECAR_FILE,
  serializeSkillSidecar,
  sidecarWithSkillMd,
  skillContractDigest,
} from '@dangosys/dsh-singularity-task-runtime'
import { EvolutionService } from '../../src/evolution.ts'
import type { CommitStage, ReconcileOutcome } from '../../src/commit.ts'
import {
  sha256Of,
  type SkillShape,
  writeSkillDirectory,
  PROMOTION_ROW,
  skillText,
  fixtureCtx,
  FIXTURE_SELECTION,
  walkToDecided,
  skillProposal,
  reopenLike,
  serviceWithProduction,
  VERSION_SET,
  ledgerKinds,
  refusalOf,
  productionSkill,
  skillCandidateGated,
  skillCandidateDirectory,
  COMMIT_TARGET,
  P3_BASELINE,
  ledgerLinesOf,
  CANDIDATE_SOURCE,
  CHAMPION_SOURCE,
  INTERRUPTED_STAGES,
  intentLine,
  intentFile,
  appliedLine,
  FORGED_TARGET,
  ledgerFixture,
  decidedLines,
  SKILL_CANDIDATE,
} from './evolution.fixture.ts'

/* ------------------------------------------------------------------ *
 * K3: the whole skill object — the fixed file set, the derivation,     *
 * and the two-file commit. Prepare freezes `SKILL.md` and, for an      *
 * execution object, the `SKILL.contract.json` beside it; the candidate *
 * sidecar is *derived* from production (only its content digest        *
 * moves), and the commit writes, verifies and recovers both files      *
 * together.                                                            *
 * ------------------------------------------------------------------ */

const SKILL_DIR = (root: string, proposalId = 's1', name = 'verify') =>
  join(root, 'sandbox', proposalId, 'skills', name)

const CHAMPION_DIR = (root: string, proposalId = 's1', name = 'verify') =>
  join(root, 'sandbox', proposalId, 'champion', 'skills', name)

const SIDECAR_TARGET = (skillRoot: string, name = 'verify') => join(skillRoot, name, SKILL_SIDECAR_FILE)

const SIDECAR_CANDIDATE_SOURCE = 'sandbox/s1/skills/verify/SKILL.contract.json'

const SIDECAR_CHAMPION_SOURCE = 'sandbox/s1/champion/skills/verify/SKILL.contract.json'

/** The declaration a sidecar file holds, as the loader and the derivation read it. */
function declaredSidecar(text: string): Record<string, any> {
  return JSON.parse(text) as Record<string, any>
}

/** The candidate sidecar the derivation produces: the production declaration with only its content digest moved. */
function derivedSidecar(productionSidecarText: string, candidateSkillMd: string): string {
  return serializeSkillSidecar(
    sidecarWithSkillMd(declaredSidecar(productionSidecarText) as never, sha256Of(candidateSkillMd)),
  )
}

/** The policy-bearing statements of a sidecar, for the "only the digest moves" assertions. */
function sidecarPolicy(text: string): Record<string, unknown> {
  const declared = declaredSidecar(text)
  return {
    contractVersion: declared.contractVersion,
    type: declared.type,
    capabilities: declared.capabilities,
    precondition: declared.precondition,
    inputs: declared.inputs,
    outputs: declared.outputs,
    requiredTools: declared.requiredTools,
    verifier: declared.verifier,
    resources: declared.content.resources,
  }
}

/** Install a production execution object: the `SKILL.md` and a sidecar whose identity covers exactly those bytes. */
async function productionExecutionObject(skillRoot: string, content: string, shape: SkillShape = {}): Promise<void> {
  await writeSkillDirectory(join(skillRoot, 'verify'), 'verify', content, {
    sidecar: 'execution',
    verifierRef: 'command',
    capabilities: [PROMOTION_ROW],
    requiredTools: ['bash'],
    ...shape,
  })
}

/** A production fixture walked to decided(PROMOTE) over an execution object; `probe` opens an interrupt window. */
async function executionDecidedFixture(
  options: {
    production?: string
    candidate?: string
    shape?: SkillShape
    probe?: (stage: CommitStage, target?: string) => void
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'evolution-object-'))
  const root = join(dir, 'evolution')
  const skillRoot = join(dir, 'skills')
  const production = options.production ?? skillText('# production execution skill')
  const candidate = options.candidate ?? skillText('# candidate execution skill')
  await productionExecutionObject(skillRoot, production, options.shape)
  const svc = new EvolutionService(fixtureCtx(), {
    modelSelection: () => FIXTURE_SELECTION,
    root,
    skillRoot,
    ...(options.probe === undefined ? {} : { commitProbe: options.probe }),
  })
  await walkToDecided(svc, skillProposal, { name: 'verify', content: candidate })
  const productionSidecar = await readFile(SIDECAR_TARGET(skillRoot), 'utf8')
  return { svc, dir, root, skillRoot, production, candidate, productionSidecar }
}

/** Reopen one fixture over the same roots with a target-aware interrupt window of its own. */
function reopenWithObjectProbe(
  svc: EvolutionService,
  roots: { root: string; skillRoot: string },
  probe?: (stage: CommitStage, target?: string) => void,
): EvolutionService {
  return reopenLike(svc, {
    modelSelection: () => FIXTURE_SELECTION,
    root: roots.root,
    skillRoot: roots.skillRoot,
    ...(probe === undefined ? {} : { commitProbe: probe }),
  })
}

/** A probe that throws at one stage, optionally only for the file the test names. */
function crashAtObject(
  stage: CommitStage,
  forFile?: 'skillMd' | 'sidecar',
): (seen: CommitStage, target?: string) => void {
  const wanted = forFile === undefined ? undefined : forFile === 'skillMd' ? 'SKILL.md' : SKILL_SIDECAR_FILE
  return (seen, target) => {
    if (seen !== stage) return
    if (wanted !== undefined && !(target ?? '').endsWith(wanted)) return
    throw new Error(
      `in-process probe throw after ${seen}${target === undefined ? '' : ` for ${target}`} — a throw, not a process exit`,
    )
  }
}

describe('K3: prepare freezes the whole skill object', () => {
  it('materializes both files, derives the candidate sidecar, and records both identities', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const production = skillText('# production execution skill')
    const candidate = skillText('# candidate execution skill')
    await productionExecutionObject(skillRoot, production)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: candidate })
    const prepared = await svc.prepare('s1', 'root-1')

    const productionSidecar = await readFile(SIDECAR_TARGET(skillRoot), 'utf8')
    const expectedCandidateSidecar = derivedSidecar(productionSidecar, candidate)
    expect(prepared.prepared).toEqual({
      sandbox: 'sandbox/s1',
      mechanical: true,
      champion: 'captured',
      skillContent: {
        name: 'verify',
        sha256: sha256Of(candidate),
        contract: {
          sha256: sha256Of(expectedCandidateSidecar),
          contractDigest: skillContractDigest(declaredSidecar(expectedCandidateSidecar) as never),
        },
      },
      skillBaseline: {
        name: 'verify',
        sha256: sha256Of(production),
        contract: {
          sha256: sha256Of(productionSidecar),
          contractDigest: skillContractDigest(declaredSidecar(productionSidecar) as never),
        },
      },
      files: [
        'skills/verify/SKILL.md',
        `skills/verify/${SKILL_SIDECAR_FILE}`,
        'champion/skills/verify/SKILL.md',
        `champion/skills/verify/${SKILL_SIDECAR_FILE}`,
      ],
    })

    // The sandbox holds the candidate text and the derived declaration — the
    // production policy with exactly one field moved.
    expect(await readFile(join(SKILL_DIR(root), 'SKILL.md'), 'utf8')).toBe(candidate)
    const sandboxSidecar = await readFile(join(SKILL_DIR(root), SKILL_SIDECAR_FILE), 'utf8')
    expect(sandboxSidecar).toBe(expectedCandidateSidecar)
    expect(sidecarPolicy(sandboxSidecar)).toEqual(sidecarPolicy(productionSidecar))
    expect(declaredSidecar(sandboxSidecar).content.skillMdSha256).toBe(sha256Of(candidate))
    expect(declaredSidecar(productionSidecar).content.skillMdSha256).toBe(sha256Of(production))

    // The champion snapshot is the production pair, byte for byte.
    expect(await readFile(join(CHAMPION_DIR(root), 'SKILL.md'), 'utf8')).toBe(production)
    expect(await readFile(join(CHAMPION_DIR(root), SKILL_SIDECAR_FILE), 'utf8')).toBe(productionSidecar)
  })

  it('refuses a production knowledge sidecar by name, writing nothing', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await writeSkillDirectory(join(skillRoot, 'verify'), 'verify', skillText('# knowledge production skill'), {
      sidecar: 'knowledge',
    })
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# candidate') })

    await expect(svc.prepare('s1', 'root-1')).rejects.toThrow(/carries a knowledge sidecar/)
    expect((await svc.get('s1')).status).toBe('candidate')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
    expect(await ledgerKinds(root)).not.toContain('prepared')
  })

  it('freezes an execution sidecar and its declared resources', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# production skill with a reference')
    const directory = join(skillRoot, 'verify')
    await mkdir(join(directory, 'references'), { recursive: true })
    await writeFile(join(directory, 'references', 'notes.md'), 'the declared resource\n')
    await writeFile(join(directory, 'SKILL.md'), content)
    await writeFile(
      join(directory, SKILL_SIDECAR_FILE),
      `${JSON.stringify(
        {
          contractVersion: 1,
          type: 'execution',
          capabilities: [PROMOTION_ROW],
          precondition: 'the fixture skill is installed where discovery looks',
          inputs: [],
          outputs: [],
          requiredTools: ['bash'],
          verifier: { ref: 'command' },
          content: {
            skillMdSha256: sha256Of(content),
            resources: [{ path: 'references/notes.md', sha256: sha256Of('the declared resource\n') }],
          },
        },
        null,
        2,
      )}\n`,
    )
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# candidate') })

    const prepared = await svc.prepare('s1', 'root-1')
    expect(prepared.prepared!.skillContent!.resources).toEqual([{ path: 'references/notes.md', sha256: sha256Of('the declared resource\n') }])
    expect(await readFile(join(SKILL_DIR(root), 'references', 'notes.md'), 'utf8')).toBe('the declared resource\n')
    expect(await readFile(join(CHAMPION_DIR(root), 'references', 'notes.md'), 'utf8')).toBe('the declared resource\n')
  })

  it('refuses a production directory the loader refuses: an undeclared file, or bytes a declaration does not cover', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# production execution skill')
    await productionExecutionObject(skillRoot, content)
    // A file the declaration does not name: "mostly covered" is not an object.
    await writeFile(join(skillRoot, 'verify', 'notes.txt'), 'a file nobody declared\n')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# candidate') })

    const refusal = await refusalOf(svc.prepare('s1', 'root-1'))
    expect(refusal).toContain('is not the loadable object its files claim')
    expect(refusal).toContain('notes.txt')
    expect((await svc.get('s1')).status).toBe('candidate')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)

    // The other direction: the declaration no longer covers the bytes.
    await rm(join(skillRoot, 'verify', 'notes.txt'))
    await writeFile(
      SIDECAR_TARGET(skillRoot),
      `${JSON.stringify(
        {
          contractVersion: 1,
          type: 'execution',
          capabilities: [PROMOTION_ROW],
          precondition: 'the fixture skill is installed where discovery looks',
          inputs: [],
          outputs: [],
          requiredTools: ['bash'],
          verifier: { ref: 'command' },
          content: { skillMdSha256: sha256Of(skillText('# another skill entirely')), resources: [] },
        },
        null,
        2,
      )}\n`,
    )
    const drifted = await refusalOf(svc.prepare('s1', 'root-1'))
    expect(drifted).toContain('is not the loadable object its files claim')
    expect(drifted).toContain('SKILL.md is not the declared content')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
  })

  it('freezes guidance resources without requiring a sidecar', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const directory = join(skillRoot, 'verify')
    await mkdir(join(directory, 'references'), { recursive: true })
    await writeFile(join(directory, 'references', 'notes.md'), 'a reference nobody declared\n')
    await writeFile(join(directory, 'SKILL.md'), skillText('# production guidance skill'))
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# candidate') })

    const prepared = await svc.prepare('s1', 'root-1')
    expect(prepared.prepared!.skillContent!.resources).toEqual([{ path: 'references/notes.md', sha256: sha256Of('a reference nobody declared\n') }])
    expect(await readFile(join(SKILL_DIR(root), 'references', 'notes.md'), 'utf8')).toBe('a reference nobody declared\n')

  })
})

describe('K3: P2 and P3 hold the whole object', () => {
  it('refuses a candidate whose SKILL.md or sidecar moved after prepare, before any write', async () => {
    for (const file of ['SKILL.md', SKILL_SIDECAR_FILE] as const) {
      const fixture = await executionDecidedFixture()
      const { svc, root, skillRoot } = fixture
      const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
      const moved =
        file === 'SKILL.md'
          ? skillText('# the candidate SKILL.md moved after prepare')
          : derivedSidecar(fixture.productionSidecar, skillText('# a sidecar derived from other bytes'))
      await writeFile(join(SKILL_DIR(root), file), moved)

      const refusal = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))
      // The moved half is refused by name: a rewritten `SKILL.md` by the content
      // identity prepare recorded, a rewritten sidecar by the whole-object
      // identity check the loader runs over the sandbox directory.
      const expected =
        file === 'SKILL.md'
          ? 'no longer matches the content identity recorded at prepare'
          : 'is not the declared content'
      expect(refusal).toContain(expected)
      expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
      expect(await ledgerKinds(root)).not.toContain('applied')
      expect(await ledgerKinds(root)).not.toContain('commit_intent')
      expect(await svc.openIntentTargets()).toEqual([])
    }
  })

  it('refuses a candidate whose recorded sidecar is missing, and one whose guidance identity gained one', async () => {
    // Recorded sidecar deleted: the object is incomplete.
    const execution = await executionDecidedFixture()
    await rm(join(SKILL_DIR(execution.root), SKILL_SIDECAR_FILE))
    // A missing half of the pair is not the object prepare froze: the whole-object
    // identity check refuses the directory by name.
    expect(await refusalOf(execution.svc.checkPromotion('s1'))).toContain('no longer matches its frozen content identity')

    // Guidance identity, sidecar added: a different object than the one frozen.
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    const content = skillText('# guidance candidate')
    await skillCandidateGated(svc, content)
    await writeSkillDirectory(skillCandidateDirectory(root), 'verify', content, {
      sidecar: 'execution',
      verifierRef: 'command',
      capabilities: [PROMOTION_ROW],
      requiredTools: ['bash'],
    })
    expect(await refusalOf(svc.checkPromotion('s1'))).toContain('no longer matches its frozen content identity')
  })

  it('refuses a candidate sidecar whose declaration moved: the derivation, not the file, is the contract', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, candidate } = fixture
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const productionSidecar = declaredSidecar(fixture.productionSidecar)
    // The candidate's sidecar with an escalated declaration — a patch the model
    // never submits, forged here to prove the promotion refuses it.
    const escalated = serializeSkillSidecar({
      ...productionSidecar,
      requiredTools: [...productionSidecar.requiredTools, 'job_output'],
      content: { skillMdSha256: sha256Of(candidate), resources: [] },
    } as never)
    await writeFile(join(SKILL_DIR(root), SKILL_SIDECAR_FILE), escalated)

    const refusal = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))
    // The bytes moved, so the whole-object identity check refuses the sandbox
    // directory by name: the promotion stops with nothing written and nothing
    // recorded.
    expect(refusal).toMatch(/no longer matches its frozen content identity/)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(fixture.production)
    expect(await svc.openIntentTargets()).toEqual([])
  })

  it('refuses a production sidecar that moved after prepare, and one that appeared beside a guidance baseline', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot } = fixture
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const declared = declaredSidecar(fixture.productionSidecar)
    await writeFile(
      SIDECAR_TARGET(skillRoot),
      serializeSkillSidecar({
        ...declared,
        requiredTools: [...declared.requiredTools, 'job_output'],
      } as never),
    )

    const refusal = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))
    // The production object is no longer the one prepare froze: the whole-object
    // identity check refuses the directory by name.
    expect(refusal).toContain('no longer matches its frozen content identity')
    expect(refusal).toContain(join(skillRoot, 'verify'))
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')

    // The other direction: production grows a sidecar the baseline never had.
    const guidance = await serviceWithProduction()
    await productionSkill(guidance.skillRoot)
    await skillCandidateGated(guidance.svc, skillText('# guidance candidate'))
    await guidance.svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
    const sidecarBefore = await readFile(join(guidance.root, 'proposals.jsonl'), 'utf8')
    await writeSkillDirectory(join(guidance.skillRoot, 'verify'), 'verify', P3_BASELINE, {
      sidecar: 'execution',
      verifierRef: 'command',
      capabilities: [PROMOTION_ROW],
      requiredTools: ['bash'],
    })
    // production now loads as an object the baseline never had: the whole-object
    // identity check refuses it by name.
    expect(await refusalOf(guidance.svc.apply('s1', 'root-1', 'approval:call-1'))).toContain(
      'no longer matches its frozen content identity',
    )
    expect(await readFile(join(guidance.root, 'proposals.jsonl'), 'utf8')).toBe(sidecarBefore)
  })

  it('refuses a promotion and a rollback whose champion sidecar no longer hashes to the recorded baseline', async () => {
    // The promotion door: the champion snapshot's sidecar half is what the
    // candidate's declaration is derived from, so a moved snapshot is refused
    // before a human is asked and before anything is written.
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot } = fixture
    const championSidecar = join(CHAMPION_DIR(root), SKILL_SIDECAR_FILE)
    const beforePromotion = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await writeFile(
      championSidecar,
      derivedSidecar(fixture.productionSidecar, skillText('# a sidecar derived from other bytes')),
    )
    const promotionRefusal = await refusalOf(svc.checkPromotion('s1'))
    expect(promotionRefusal).toContain('no longer holds the sidecar bytes prepare recorded')
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(beforePromotion)
    expect(await svc.openIntentTargets()).toEqual([])

    // The rollback door: restore the snapshot, apply for real, then damage the
    // sidecar half — the rollback refuses before any intent is recorded, and
    // production keeps both files of the applied object.
    await writeFile(championSidecar, fixture.productionSidecar)
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const beforeRollback = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await writeFile(championSidecar, derivedSidecar(fixture.productionSidecar, skillText('# the snapshot was damaged')))
    const rollbackRefusal = await refusalOf(svc.rollback('s1', 'root-1', 'approval:call-2'))
    // The champion snapshot no longer loads as the frozen pair, so the
    // whole-object identity check refuses it by name.
    expect(rollbackRefusal).toContain('is not loadable')
    expect(rollbackRefusal).toContain(CHAMPION_DIR(root))
    expect(rollbackRefusal).toContain('is not the declared content')
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(beforeRollback)
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(fixture.candidate)
    expect(await readFile(SIDECAR_TARGET(skillRoot), 'utf8')).toBe(
      derivedSidecar(fixture.productionSidecar, fixture.candidate),
    )
    expect(await svc.openIntentTargets()).toEqual([])
  })
})

/**
 * The derivation re-check is the promotion gate's own line of defence, and this
 * describe reaches it directly.
 *
 * Through the model-facing entries the branch is unreachable: a sandbox sidecar
 * anybody touches trips P2's byte check first. What it really guards is the
 * *hand-forged ledger* path: a prepared record whose candidate-sidecar identity
 * is self-consistent with the swapped bytes (the exact-byte digest and the
 * canonical declaration digest both match them), but whose declaration is not
 * the production object's. The fold validates shapes and P2 compares bytes with
 * the record, so both pass — only re-deriving the sidecar from the champion's
 * own bytes plus the candidate `SKILL.md` digest can tell the two apart.
 */
describe('K3: the derivation check refuses a forged ledger whose prepared sidecar is not production\u2019s', () => {
  it('refuses a hand-written prepared identity covering an escalated sidecar, before P2\u2019s wording could', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, production, productionSidecar, candidate } = fixture
    const sidecarPath = join(SKILL_DIR(root), SKILL_SIDECAR_FILE)
    expect(await readFile(sidecarPath, 'utf8')).toBe(derivedSidecar(productionSidecar, candidate))

    // The swapped declaration: the production policy with one more tool added
    // that the capability table *does* grant (`read` expands from the fixture
    // row's labels), so the provider validator stays silent — a real widening
    // of what the skill demands, and the forged identity below covers exactly
    // these bytes.
    const escalated = serializeSkillSidecar({
      ...declaredSidecar(productionSidecar),
      requiredTools: [...declaredSidecar(productionSidecar).requiredTools, 'read'],
      content: { skillMdSha256: sha256Of(candidate), resources: [] },
    } as never)
    const escalatedIdentity = {
      sha256: sha256Of(escalated),
      contractDigest: skillContractDigest(declaredSidecar(escalated) as never),
    }
    await writeFile(sidecarPath, escalated)

    // The hand-forged ledger: every real line kept, and only the prepared
    // record's candidate-sidecar half replaced by the swapped bytes' own
    // identity. The shape is flawless — hex64 digests, the baseline half
    // untouched — which is exactly the attack surface.
    const lines = await ledgerLinesOf(root)
    const prepared = lines.find(line => line.kind === 'prepared')!
    prepared.skillContent.contract = escalatedIdentity
    await writeFile(join(root, 'proposals.jsonl'), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)

    const forged = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })

    // The fold accepts the record — no fold defence stands between this ledger
    // and the promotion gate.
    const folded = await forged.get('s1')
    expect(folded.prepared!.skillContent!.contract).toEqual(escalatedIdentity)
    // The baseline half is the real one, untouched: the forged record is
    // self-consistent, not visibly broken.
    expect(folded.prepared!.skillBaseline!.contract).toEqual({
      sha256: sha256Of(productionSidecar),
      contractDigest: skillContractDigest(declaredSidecar(productionSidecar) as never),
    })
    // P2 accepts the pair too: the sandbox sidecar really is the bytes the
    // record names, so nothing but the derivation re-check is left.
    expect((await forged.readSkillCandidate('s1')).sidecar!.toString('utf8')).toBe(escalated)

    const ledgerBefore = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const message = await refusalOf(forged.checkPromotion('s1'))
    expect(message).toContain('not the declaration derived from production')
    expect(message).toContain('required tools')
    expect(message).not.toContain('no longer matches the content identity recorded at prepare')

    // apply runs the same check before any intent is recorded or any byte is
    // written: production and the ledger stay exactly as they were.
    const applied = await refusalOf(forged.apply('s1', 'root-1', 'approval:call-1'))
    expect(applied).toContain('not the declaration derived from production')
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(ledgerBefore)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect(await readFile(SIDECAR_TARGET(skillRoot), 'utf8')).toBe(productionSidecar)
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(production)
  })
})

describe('K3: the two-file commit', () => {
  it('applies both files as one commit and rolls the pair back', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, production, candidate, productionSidecar } = fixture
    const expectedAppliedSidecar = derivedSidecar(productionSidecar, candidate)
    const outcome = await svc.apply('s1', 'root-1', 'approval:call-1')
    const skillTarget = COMMIT_TARGET(skillRoot)
    const sidecarTarget = SIDECAR_TARGET(skillRoot)

    expect(outcome.targets).toEqual([skillTarget, sidecarTarget])
    expect(await readFile(skillTarget, 'utf8')).toBe(candidate)
    const appliedSidecar = await readFile(sidecarTarget, 'utf8')
    expect(appliedSidecar).toBe(expectedAppliedSidecar)
    expect(sidecarPolicy(appliedSidecar)).toEqual(sidecarPolicy(productionSidecar))

    const intent = (await ledgerLinesOf(root)).find(line => line.kind === 'commit_intent')!
    expect(intent.files).toEqual([
      {
        target: skillTarget,
        baselineSha256: sha256Of(production),
        contentSha256: sha256Of(candidate),
        source: CANDIDATE_SOURCE,
      },
      {
        target: sidecarTarget,
        baselineSha256: sha256Of(productionSidecar),
        contentSha256: sha256Of(expectedAppliedSidecar),
        source: SIDECAR_CANDIDATE_SOURCE,
      },
    ])
    const applied = (await ledgerLinesOf(root)).find(line => line.kind === 'applied')!
    expect(applied.targets).toEqual([skillTarget, sidecarTarget])
    expect((await svc.get('s1')).status).toBe('applied')
    expect(await svc.openIntentTargets()).toEqual([])
    expect((await readdir(join(skillRoot, 'verify'))).filter(entry => entry.includes('.tmp-'))).toEqual([])

    const rolled = await svc.rollback('s1', 'root-1', 'approval:call-2')
    expect(rolled.targets).toEqual([skillTarget, sidecarTarget])
    expect(await readFile(skillTarget, 'utf8')).toBe(production)
    expect(await readFile(sidecarTarget, 'utf8')).toBe(productionSidecar)
    const rollbackIntent = (await ledgerLinesOf(root)).filter(line => line.kind === 'commit_intent')[1]!
    expect(rollbackIntent.files.map((file: { source: string }) => file.source)).toEqual([
      CHAMPION_SOURCE,
      SIDECAR_CHAMPION_SOURCE,
    ])
    expect((await ledgerLinesOf(root)).find(line => line.kind === 'rolledback')!.targets).toEqual([
      skillTarget,
      sidecarTarget,
    ])
    expect(await svc.openIntentTargets()).toEqual([])
  })

  it('refuses a rollback whose sidecar no longer holds what the proposal applied, before any intent', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, production } = fixture
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await writeFile(
      SIDECAR_TARGET(skillRoot),
      derivedSidecar(fixture.productionSidecar, skillText('# a third party rewrote the sidecar')),
    )

    const refusal = await refusalOf(svc.rollback('s1', 'root-1', 'approval:call-2'))
    // The production pair no longer loads as the frozen candidate object, so the
    // whole-object identity check refuses it by name before any intent.
    expect(refusal).toContain('is not loadable')
    expect(refusal).toContain(join(skillRoot, 'verify'))
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(await svc.openIntentTargets()).toEqual([])
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).not.toBe(production)
  })

  it('names the rewritten file when a commit stops, for either file of the pair', async () => {
    for (const file of ['SKILL.md', SKILL_SIDECAR_FILE] as const) {
      const fixture = await executionDecidedFixture()
      const { svc, root, skillRoot } = fixture
      const crashing = reopenWithObjectProbe(svc, fixture, crashAtObject('intent-recorded'))
      await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))
      const reopened = reopenWithObjectProbe(svc, fixture)
      const target = file === 'SKILL.md' ? COMMIT_TARGET(skillRoot) : SIDECAR_TARGET(skillRoot)
      await writeFile(target, '# a third party rewrote this file\n')
      const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')

      const [outcome] = await reopened.reconcile()
      expect(outcome!.result).toBe('blocked')
      expect(outcome!.targets).toEqual([COMMIT_TARGET(skillRoot), SIDECAR_TARGET(skillRoot)])
      expect(outcome!.detail).toContain(target)
      expect(outcome!.detail).toContain('a third party changed it')
      expect(await readFile(target, 'utf8')).toBe('# a third party rewrote this file\n')
      expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
      expect((await reopened.get('s1')).openIntent?.intentId).toBe('s1/apply')
    }
  })

  it.each([
    ['intent-recorded', undefined, 'completed-redone'],
    ['write-staged', undefined, 'completed-redone'],
    // The plain window is between the two renames: SKILL.md landed, the sidecar
    // has not, so the recovery finishes the pair (`completed-redone`).
    ['write-renamed', undefined, 'completed-redone'],
    // After the *second* rename every file is in place: only the record is missing.
    ['write-renamed', 'sidecar', 'completed-written'],
    ['commit-verified', undefined, 'completed-written'],
  ] as const)(
    'settles an apply interrupted after %s%s with both files and one completion row',
    async (stage, forFile, expected) => {
      const fixture = await executionDecidedFixture()
      const { svc, root, skillRoot, candidate, productionSidecar } = fixture
      const crashing = reopenWithObjectProbe(svc, fixture, crashAtObject(stage, forFile))
      expect(await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))).toContain(
        `in-process probe throw after ${stage}`,
      )
      const reopened = reopenWithObjectProbe(svc, fixture)
      expect((await ledgerKinds(root)).at(-1)).toBe('commit_intent')

      const outcomes = await reopened.reconcile()
      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]!.targets).toEqual([COMMIT_TARGET(skillRoot), SIDECAR_TARGET(skillRoot)])
      expect(outcomes[0]!.result).toBe(expected)
      expect(await readFile(SIDECAR_TARGET(skillRoot), 'utf8')).toBe(derivedSidecar(productionSidecar, candidate))
      expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(candidate)
      const settledKinds = await ledgerKinds(root)
      expect(settledKinds.filter(kind => kind === 'applied')).toHaveLength(1)
      const applied = (await ledgerLinesOf(root)).find(line => line.kind === 'applied')!
      expect(applied.targets).toEqual([COMMIT_TARGET(skillRoot), SIDECAR_TARGET(skillRoot)])
      expect((await reopened.get('s1')).openIntent).toBeUndefined()
    },
  )

  it('finishes the mixed window: only SKILL.md renamed, then the sidecar written by the recovery', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, production, candidate, productionSidecar } = fixture
    // Between the two renames: the SKILL.md is the new version, the sidecar
    // still the old one — a pair no loader accepts, and exactly the state the
    // ledger intent explains.
    const crashing = reopenWithObjectProbe(svc, fixture, crashAtObject('write-renamed', 'skillMd'))
    expect(await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))).toContain(
      'in-process probe throw after write-renamed',
    )
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(candidate)
    expect(await readFile(SIDECAR_TARGET(skillRoot), 'utf8')).not.toBe(derivedSidecar(productionSidecar, candidate))

    const reopened = reopenWithObjectProbe(svc, fixture)
    const [outcome] = await reopened.reconcile()
    expect(outcome!.result).toBe('completed-redone')
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(candidate)
    expect(await readFile(SIDECAR_TARGET(skillRoot), 'utf8')).toBe(derivedSidecar(productionSidecar, candidate))
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
    expect((await reopened.get('s1')).openIntent).toBeUndefined()
    expect(await reopened.reconcile()).toEqual([])
    expect(production).not.toBe(candidate)
  })

  it('settles a commit interrupted after every write verified: only the completion is recorded', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, candidate } = fixture
    const crashing = reopenWithObjectProbe(svc, fixture, crashAtObject('commit-verified'))
    expect(await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))).toContain(
      'in-process probe throw after commit-verified',
    )
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(candidate)
    expect(await ledgerKinds(root)).not.toContain('applied')

    const reopened = reopenWithObjectProbe(svc, fixture)
    const [outcome] = await reopened.reconcile()
    expect(outcome!.result).toBe('completed-written')
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
    expect((await ledgerLinesOf(root)).find(line => line.kind === 'applied')!.targets).toEqual([
      COMMIT_TARGET(skillRoot),
      SIDECAR_TARGET(skillRoot),
    ])
    expect(await reopened.reconcile()).toEqual([])
  })

  it.each(INTERRUPTED_STAGES)('settles a rollback interrupted after %s over the pair', async stage => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, production, productionSidecar } = fixture
    await svc.apply('s1', 'root-1', 'approval:call-1')
    const crashing = reopenWithObjectProbe(svc, fixture, crashAtObject(stage))
    await refusalOf(crashing.rollback('s1', 'root-1', 'approval:call-2'))
    const reopened = reopenWithObjectProbe(svc, fixture)

    const outcomes = await reopened.reconcile()
    // Same windows as an apply: the plain `write-renamed` window is between the
    // two renames, so the recovery finishes the pair.
    expect(outcomes.map(outcome => outcome.result)).toEqual(['completed-redone'])
    expect(await readFile(COMMIT_TARGET(skillRoot), 'utf8')).toBe(production)
    expect(await readFile(SIDECAR_TARGET(skillRoot), 'utf8')).toBe(productionSidecar)
    expect((await ledgerKinds(root)).filter(kind => kind === 'rolledback')).toHaveLength(1)
    expect((await ledgerLinesOf(root)).find(line => line.kind === 'rolledback')!.targets).toEqual([
      COMMIT_TARGET(skillRoot),
      SIDECAR_TARGET(skillRoot),
    ])
  })

  it('blocks both proposals of one skill directory: the per-object gate matches the directory, not one file', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot } = fixture
    await walkToDecided(
      svc,
      { ...skillProposal, proposalId: 's2' },
      { name: 'verify', content: skillText('# the second candidate') },
    )
    const crashing = reopenWithObjectProbe(svc, fixture, crashAtObject('intent-recorded'))
    await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))
    const reopened = reopenWithObjectProbe(svc, fixture)
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')

    const refusal = await refusalOf(reopened.apply('s2', 'root-1', 'approval:call-2'))
    expect(refusal).toContain("another proposal's unsettled intent")
    expect(refusal).toContain(dirname(SIDECAR_TARGET(skillRoot)))
    expect(refusal).toContain('s1/apply')
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)

    // Settling the first proposal's intent admits commits again — and the second
    // proposal's own baseline check then refuses it, because production moved.
    expect((await reopened.reconcile()).map(outcome => outcome.result)).toEqual(['completed-redone'])
    expect(await reopened.openIntentTargets()).toEqual([])
    expect(await refusalOf(reopened.apply('s2', 'root-1', 'approval:call-2'))).toContain(
      'no longer matches its frozen content identity',
    )
  })

  it('reports the blocked intent, instead of throwing, when the production directory cannot be listed', async () => {
    const fixture = await executionDecidedFixture()
    const { svc, root, skillRoot, production, productionSidecar } = fixture
    const skillTarget = COMMIT_TARGET(skillRoot)
    const sidecarTarget = SIDECAR_TARGET(skillRoot)
    const directory = join(skillRoot, 'verify')
    const crashing = reopenWithObjectProbe(svc, fixture, crashAtObject('intent-recorded'))
    await refusalOf(crashing.apply('s1', 'root-1', 'approval:call-1'))

    // One open intent, nothing written: both files still hold the baseline, and
    // the intent names them.
    const ledgerBefore = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const entriesBefore = (await readdir(directory)).sort()
    expect(await ledgerKinds(root)).toContain('commit_intent')
    expect(await readFile(skillTarget, 'utf8')).toBe(production)
    expect(await readFile(sidecarTarget, 'utf8')).toBe(productionSidecar)

    // The window this pins: every file the intent names is still readable one by
    // one (the directory keeps `x`), but the directory itself cannot be listed —
    // so what else it holds is unknowable to the pre-write object check. That is
    // a refusal to *report*, not an exception to throw: a recovery that threw
    // here would abort the whole batch over one directory, and the caller would
    // never see the named reason.
    const reopened = reopenWithObjectProbe(svc, fixture)
    await chmod(directory, 0o300)
    let outcomes: ReconcileOutcome[] = []
    try {
      outcomes = await reopened.reconcile()
    } catch (error) {
      throw new Error(
        `reconcile() threw instead of reporting a blocked intent: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      await chmod(directory, 0o755)
    }

    expect(outcomes).toHaveLength(1)
    const [outcome] = outcomes
    expect(outcome!.result).toBe('blocked')
    expect(outcome!.targets).toEqual([skillTarget, sidecarTarget])
    expect(outcome!.detail).toContain('cannot be read to check what it holds')
    expect(outcome!.detail).toContain(directory)
    expect(outcome!.detail).toContain('the intent stays open')
    expect(outcome!.detail).toContain('nothing is written')

    // Zero writes: the same ledger bytes (no completion line was appended), the
    // same two files, the same directory entries, and the intent still open.
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(ledgerBefore)
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied' || kind === 'rolledback')).toEqual([])
    expect(await readFile(skillTarget, 'utf8')).toBe(production)
    expect(await readFile(sidecarTarget, 'utf8')).toBe(productionSidecar)
    expect((await readdir(directory)).sort()).toEqual(entriesBefore)
    expect((await reopened.get('s1')).openIntent?.intentId).toBe('s1/apply')
    expect(await reopened.openIntentTargets()).toEqual([skillTarget, sidecarTarget])

    // The fresh path over the same obstacle, on a world whose proposal has no
    // open intent: the production-baseline whole-object check reads the same
    // directory through the loader, which refuses it outright, so nothing is
    // recorded and production keeps the baseline.
    const fresh = await executionDecidedFixture()
    const freshDirectory = join(fresh.skillRoot, 'verify')
    const freshBefore = await readFile(join(fresh.root, 'proposals.jsonl'), 'utf8')
    await chmod(freshDirectory, 0o300)
    try {
      await expect(fresh.svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow(/permission denied|EACCES/i)
    } finally {
      await chmod(freshDirectory, 0o755)
    }
    expect(await readFile(join(fresh.root, 'proposals.jsonl'), 'utf8')).toBe(freshBefore)
    expect(await ledgerKinds(fresh.root)).not.toContain('commit_intent')
    expect(await readFile(COMMIT_TARGET(fresh.skillRoot), 'utf8')).toBe(fresh.production)
    expect((await fresh.svc.get('s1')).status).toBe('decided')
  })
})

describe('K3: fold invariants for the two-file object', () => {
  it("refuses a completion whose target list is not the intent's file set, in order", async () => {
    const twoFile = intentLine({
      files: [intentFile(), { ...intentFile(), target: '/production/skills/verify/SKILL.contract.json' }],
    })
    const reordered = appliedLine({ targets: ['/production/skills/verify/SKILL.contract.json', FORGED_TARGET] })
    const { svc } = await ledgerFixture(decidedLines([twoFile, reordered]))
    await expect(svc.list()).rejects.toThrow(/a completion records the exact file set its intent committed/)

    const { svc: short } = await ledgerFixture(decidedLines([twoFile, appliedLine()]))
    await expect(short.list()).rejects.toThrow(/a completion records the exact file set its intent committed/)
  })

  it('refuses a prepared record whose candidate and baseline identities disagree about the object shape', async () => {
    const lines = decidedLines()
    const prepared = lines[2] as Record<string, unknown>
    const fixture = await ledgerFixture([
      ...lines.slice(0, 2),
      {
        ...prepared,
        skillContent: {
          name: 'verify',
          sha256: sha256Of(SKILL_CANDIDATE),
          contract: { sha256: sha256Of('a sidecar'), contractDigest: sha256Of('a digest') },
        },
      },
      ...lines.slice(3),
    ])
    await expect(fixture.svc.list()).rejects.toThrow(/mixes object shapes/)
  })

  it('refuses a prepared record whose contract half is malformed', async () => {
    const lines = decidedLines()
    const prepared = lines[2] as Record<string, unknown>
    const fixture = await ledgerFixture([
      ...lines.slice(0, 2),
      {
        ...prepared,
        skillBaseline: {
          name: 'verify',
          sha256: sha256Of(P3_BASELINE),
          contract: { sha256: 'not-a-digest', contractDigest: sha256Of('x') },
        },
      },
      ...lines.slice(3),
    ])
    await expect(fixture.svc.list()).rejects.toThrow(/skillBaseline\.contract must be \{ sha256, contractDigest \}/)
  })
})

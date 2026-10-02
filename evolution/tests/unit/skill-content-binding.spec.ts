import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EvolutionService } from '../../src/evolution.ts'
import { digestOf } from '../../src/replay.ts'
import { defineEvolutionApplyTool } from '../../../agent-singularity/src/tools/evolution-apply.ts'
import { defineEvolutionDecideTool } from '../../../agent-singularity/src/tools/evolution-decide.ts'
import {
  SKILL_CANDIDATE,
  skillProposal,
  serviceWithProduction,
  PRODUCTION_V1,
  recordSkillExperiment,
  gateAnswers,
  preparedSkillExperiment,
  exec,
  experimentReportPathOf,
  requireProductionSkill,
  refusalOf,
  ledgerKinds,
  reopenLike,
  FIXTURE_SELECTION,
  toolCtx,
  productionSkill,
  P3_BASELINE,
  skillProductionFile,
  P3_CANDIDATE_A,
  skillText,
  walkSkillToDecided,
  P3_CANDIDATE_B,
  fixtureCtx,
  VERSION_SET,
  capabilityProposal,
  CAPABILITY_FIXTURE_SKILL,
} from './evolution.fixture.ts'

/**
 * P2-D race seam: wraps `node:fs/promises.readFile` so a test can replace a
 * candidate SKILL.md on disk immediately after a read of it completes. Inert
 * unless a test arms `onCandidateRead` — every other call passes straight
 * through to the real fs.
 */
const candidateReadHooks = vi.hoisted(() => ({
  onCandidateRead: undefined as undefined | ((path: string, readCount: number) => Promise<void> | void),
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const read = actual.readFile as (path: unknown, options?: unknown) => Promise<unknown>
  let candidateReads = 0
  return {
    ...actual,
    readFile: async (path: unknown, options?: unknown) => {
      const bytes = await read(path, options)
      const asPath = String(path)
      if (asPath.includes(`${sep}sandbox${sep}`) && asPath.endsWith(`${sep}SKILL.md`)) {
        candidateReads += 1
        await candidateReadHooks.onCandidateRead?.(asPath, candidateReads)
      }
      return bytes
    },
  } as typeof actual
})

const skillCandidateFile = (root: string, proposalId = 's1') =>
  join(root, 'sandbox', proposalId, 'skills', 'verify', 'SKILL.md')

/** propose → candidate → prepare a skill proposal; returns the recorded content identity. */
async function prepareSkill(svc: EvolutionService, content: string = SKILL_CANDIDATE) {
  await svc.propose(skillProposal, 'root-1')
  await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content })
  const prepared = await svc.prepare('s1', 'root-1')
  return prepared.prepared!.skillContent!
}

const P3_CONFLICT_GUIDANCE = 'create a new candidate from the current production state and re-evaluate it'

/** Rewrite a live ledger as a P2-era one: the prepared line loses `skillBaseline`, the field P3 added. */
async function dropBaselineField(root: string) {
  const path = join(root, 'proposals.jsonl')
  const lines = (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map(line => {
      const record = JSON.parse(line)
      if (record.kind === 'prepared') delete record.skillBaseline
      return JSON.stringify(record)
    })
  await writeFile(path, `${lines.join('\n')}\n`)
}

describe('skill candidate content binding (P2)', () => {
  it('P2-A: an untouched candidate walks prepare → replay → gate → decide → apply with byte-identical production content', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const identity = await prepareSkill(svc)
    // the digest is over the exact file bytes — no trim, no newline conversion
    expect(identity).toEqual({
      name: 'verify',
      sha256: createHash('sha256').update(SKILL_CANDIDATE, 'utf8').digest('hex'),
    })
    expect(await readFile(skillCandidateFile(root), 'utf8')).toBe(SKILL_CANDIDATE)
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    const evidenceFile = join(root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await svc.gate('s1', gateAnswers([evidenceFile, reportPath]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
    await svc.apply('s1', 'root-1', 'approval:call-1')

    // production content is byte-equal to the verified candidate bytes
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'))).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    // the experiment's frozen block names exactly the prepared identity
    expect(JSON.parse(await readFile(join(root, reportPath), 'utf8')).frozen.candidate).toEqual(identity)
    const applied = await svc.get('s1')
    expect(applied.status).toBe('applied')
    expect(applied.prepared!.skillContent).toEqual(identity)
    expect(applied.history.map(entry => entry.status)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'gated',
      'decided',
      'applied',
    ])
  })

  it('P2-A: the experiment binds the report to the verified candidate and the prepare-time production baseline, never to production rewritten since', async () => {
    const { root, skillRoot, replayTask, replayTool, experiment } = await preparedSkillExperiment()
    // rewriting production must not move either identity: the candidate is
    // re-verified in the sandbox, and the baseline was captured at prepare
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# production rewritten\n')
    const result = (await replayTool.execute(
      { proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] },
      exec('root-1'),
    )) as string
    expect(result).toContain('proposal s1 [experiment] skill verify — verdict: fixed')

    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>)
    const started = lines.find(line => line.kind === 'experiment_started') as { frozen: Record<string, any> }
    expect(started.frozen.candidate).toEqual(experiment.identity)
    expect(started.frozen.productionBaseline).toEqual({
      name: 'verify',
      sha256: createHash('sha256').update(PRODUCTION_V1, 'utf8').digest('hex'),
    })
    expect(experiment.identity.sha256).not.toBe(
      createHash('sha256').update('# production rewritten\n', 'utf8').digest('hex'),
    )
    // the overlay is the sandbox candidate, never the production skill
    expect(replayTask.mock.calls.filter(call => call[2].overlay !== undefined)).toHaveLength(2)
    expect(replayTask.mock.calls.every(call => call[2].lineage?.startsWith('evolution-experiment:'))).toBe(true)
  })

  it('P2-B: a candidate modified after prepare is refused before any run, tool and service alike', async () => {
    const { svc, root, replayTask, replayTool, experiment } = await preparedSkillExperiment()
    await writeFile(skillCandidateFile(root), 'tampered after prepare\n')

    const viaTool = (await replayTool.execute(
      { proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] },
      exec('root-1'),
    )) as string
    expect(viaTool).toContain('evolution_replay rejected:')
    expect(viaTool).toContain('no longer matches the content identity recorded at prepare')
    expect(replayTask).not.toHaveBeenCalled()

    // the same refusal through the service's own candidate read — the shared
    // identity check every promotion stage and the experiment's pre-run check use
    await expect(svc.readSkillCandidate('s1')).rejects.toThrow(
      'no longer matches the content identity recorded at prepare',
    )
    expect((await svc.get('s1')).status).toBe('prepared')
    expect(existsSync(join(root, 'sandbox', 's1', 'replay-report.json'))).toBe(false)
  })

  it('keeps the candidate bytes out of production through the whole experiment, whatever the runs do', async () => {
    const { root, skillRoot, replayTask, replayTool } = await preparedSkillExperiment()
    // The experiment writes into its own sandboxes and sandbox workspaces only;
    // a run that rearranges its own workspace cannot reach the production skill.
    await replayTool.execute({ proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] }, exec('root-1'))
    expect(replayTask).toHaveBeenCalledTimes(4)
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
    expect(existsSync(join(root, 'sandbox', 's1', 'replay-report.json'))).toBe(false)
  })

  it('P2-B: a candidate modified after the replay is refused at decide and apply, with no successful-promotion state', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await writeFile(skillCandidateFile(root), 'rewritten after the replay\n')

    await expect(svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow(
      'no longer matches the content identity',
    )
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    expect((await svc.get('s1')).status).toBe('gated')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(kinds).not.toContain('decided')
    expect(kinds).not.toContain('applied')
  })

  it('P2-C: refuses a deleted candidate and a directory in its place', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await requireProductionSkill(skillRoot)
    await prepareSkill(svc)
    await rm(skillCandidateFile(root))
    await expect(svc.readSkillCandidate('s1')).rejects.toThrow('is missing under')

    await mkdir(skillCandidateFile(root))
    await expect(svc.readSkillCandidate('s1')).rejects.toThrow('is not a regular file')
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it('P2-C: refuses a symlinked candidate file or ancestor and never writes the link target', async () => {
    const { svc, dir, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')

    const outside = join(dir, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'SKILL.md'), 'external content\n')
    // the skill directory itself becomes a symlink to the outside target
    const verifyDir = join(root, 'sandbox', 's1', 'skills', 'verify')
    await rm(verifyDir, { recursive: true, force: true })
    await symlink(outside, verifyDir)
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('is a symbolic link')
    expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe('external content\n')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
    expect((await svc.get('s1')).status).toBe('decided')

    // the candidate file itself as a symlink is refused at replay time
    await rm(verifyDir)
    await mkdir(verifyDir, { recursive: true })
    await writeFile(join(outside, 'SKILL.md'), 'external content\n')
    await symlink(join(outside, 'SKILL.md'), skillCandidateFile(root))
    await expect(svc.readSkillCandidate('s1')).rejects.toThrow('is a symbolic link')
  })

  it("P2-D: a commit stops by name when the source is replaced after the write's own read", async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')

    const candidate = skillCandidateFile(root)
    const replacement = 'replaced after the candidate read\n'
    let reads = 0
    let fired = 0
    candidateReadHooks.onCandidateRead = async path => {
      if (path !== candidate) return
      reads += 1
      // apply reads the candidate three times — checkPromotion's identity read,
      // the promotion's provider check (S1-C item 3), and the write's own read.
      // The source is replaced only after that last read completes,
      // deterministically, with no sleep-based race; the commit's own re-read of
      // the source it is about to name in the intent is a fourth read, and that
      // is the one the replacement is caught by.
      if (reads === 3) {
        fired += 1
        await writeFile(candidate, replacement)
      }
    }
    let message: string
    try {
      message = await refusalOf(svc.apply('s1', 'root-1', 'approval:call-1'))
    } finally {
      candidateReadHooks.onCandidateRead = undefined
    }
    expect(fired).toBe(1)
    // The source an intent names must be re-verifiable *before* the intent is
    // recorded: a source that changed after the caller's own verified read stops
    // the commit by name, so nothing is written and no line is recorded.
    expect(message).toMatch(/does not hold the bytes its commit recorded/)
    expect(message).toMatch(/no line is recorded/)
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
    expect(await readFile(candidate, 'utf8')).toBe(replacement)
    expect(await ledgerKinds(root)).not.toContain('commit_intent')
    expect((await svc.get('s1')).openIntent).toBeUndefined()
    // and the replaced source can no longer verify for any later stage
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    await expect(reopened.checkPromotion('s1')).rejects.toThrow('no longer matches the content identity')
  })

  it('P2-E: the crate the experiment freezes names the prepared candidate identity', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await requireProductionSkill(skillRoot)
    const identity = await prepareSkill(svc)
    expect(identity.sha256).toMatch(/^[a-f0-9]{64}$/)
    // A recorded experiment whose frozen identity is not the prepared bytes is
    // refused at the promotion gate: the evidence belongs to other content.
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    const frozen = JSON.parse(await readFile(join(root, reportPath), 'utf8'))
    expect(frozen.frozen.candidate).toEqual(identity)
    expect(JSON.parse(await readFile(join(root, reportPath), 'utf8')).formatVersion).toBe(3)
  })

  it('P2-F: a reopened service enforces the same identity checks', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await writeFile(skillCandidateFile(root), 'rewritten across a restart\n')

    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    await expect(reopened.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow(
      'no longer matches the content identity',
    )
    await expect(reopened.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    expect((await reopened.get('s1')).status).toBe('gated')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
  })

  it('P2-G: an illegitimate candidate is refused before the human is asked', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await writeFile(skillCandidateFile(root), 'rewritten before the human review\n')

    const { ctx, approval } = toolCtx(svc)
    const result = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 's1', decision: 'PROMOTE' },
      exec('root-1'),
    )) as string
    expect(result).toContain('evolution_decide rejected:')
    expect(result).toContain('no longer matches the content identity')
    expect(approval.request).not.toHaveBeenCalled()
    expect((await svc.get('s1')).status).toBe('gated')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
  })

  it('P2-G: a candidate changed while the human approval is pending is refused by the service recheck', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')

    // The approval mock is the controllable hook: it rewrites the candidate
    // while the human is deciding, then grants. The service entry rechecks.
    const approval = {
      request: vi.fn(async () => {
        await writeFile(skillCandidateFile(root), 'rewritten while the human decided\n')
        return 'allowed-once' as const
      }),
    }
    const base = toolCtx(svc)
    const ctx = { ...(base.ctx as unknown as Record<string, unknown>), approval } as never
    const result = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 's1', decision: 'PROMOTE' },
      exec('root-1'),
    )) as string
    expect(approval.request).toHaveBeenCalledOnce()
    expect(result).toContain('evolution_decide rejected:')
    expect(result).toContain('no longer matches the content identity')
    expect((await svc.get('s1')).status).toBe('gated')
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(kinds).not.toContain('decided')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
  })

  it('P2-G: the apply tool rechecks the identity after its own approval and writes nothing on a changed candidate', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')

    const approval = {
      request: vi.fn(async () => {
        await writeFile(skillCandidateFile(root), 'rewritten while the human decided\n')
        return 'allowed-once' as const
      }),
    }
    const base = toolCtx(svc)
    const ctx = { ...(base.ctx as unknown as Record<string, unknown>), approval } as never
    const result = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(approval.request).toHaveBeenCalledOnce()
    expect(result).toContain('evolution_apply rejected:')
    expect(result).toContain('no longer matches the content identity')
    expect((await svc.get('s1')).status).toBe('decided')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(kinds).not.toContain('applied')
  })
})

describe('production baseline check (P3)', () => {
  it('P3-A: an unchanged champion with every P2 prerequisite applies and writes the verified candidate bytes', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    const identity = await prepareSkill(svc)
    // the baseline is the digest of the production bytes, taken from the same
    // single read that produced the champion snapshot — the two cannot disagree
    const prepared = await svc.get('s1')
    expect(prepared.prepared!.skillBaseline).toEqual({
      name: 'verify',
      sha256: createHash('sha256').update(P3_BASELINE, 'utf8').digest('hex'),
    })
    expect(await readFile(join(root, 'sandbox', 's1', 'champion', 'skills', 'verify', 'SKILL.md'))).toEqual(
      Buffer.from(P3_BASELINE, 'utf8'),
    )

    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
    // the precheck the apply tool runs before asking a human passes untouched
    await svc.checkProductionBaseline('s1')

    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(applied.targets).toEqual([join(skillRoot, 'verify', 'SKILL.md')])
    expect(await readFile(skillProductionFile(skillRoot))).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
    expect((await svc.get('s1')).status).toBe('applied')
    expect(await ledgerKinds(root)).toContain('applied')
  })

  it.each([
    ['modified after prepare', 'rewritten in production\n'],
    ['deleted after prepare', null],
  ])(
    'P3-B: production %s is refused at apply, tool and service alike, and keeps its new state',
    async (_label, next) => {
      const { svc, root, skillRoot } = await serviceWithProduction()
      await productionSkill(skillRoot)
      const identity = await prepareSkill(svc)
      await recordSkillExperiment(svc, 's1')
      await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
      await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
      if (next === null) await rm(skillProductionFile(skillRoot))
      else await writeFile(skillProductionFile(skillRoot), next)

      // the tool refuses before the human is asked — no approval is burned
      const { ctx, approval } = toolCtx(svc)
      const viaTool = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
      expect(viaTool).toContain('evolution_apply rejected:')
      expect(viaTool).toContain(P3_CONFLICT_GUIDANCE)
      expect(approval.request).not.toHaveBeenCalled()

      // and a direct service call cannot bypass the same check
      await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow(
        next === null ? /no longer exists/ : /changed since prepare/,
      )
      expect((await svc.get('s1')).status).toBe('decided')
      expect((await svc.get('s1')).applied).toBeUndefined()
      expect(await ledgerKinds(root)).not.toContain('applied')
      // production keeps whatever it now holds: the modified bytes, or the absence
      expect(existsSync(skillProductionFile(skillRoot))).toBe(next !== null)
      if (next !== null) expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(next)
      // the candidate, its report and its history are preserved for a fresh proposal
      expect((await svc.readSkillCandidate('s1')).skillMd).toEqual(Buffer.from(SKILL_CANDIDATE, 'utf8'))
      expect((await svc.get('s1')).history.map(entry => entry.status)).toEqual([
        'proposed',
        'candidate',
        'prepared',
        'gated',
        'decided',
      ])
    },
  )

  it('P3-C: a brand-new skill has no production state to be prepared against, so prepare refuses it and production is preserved', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: P3_CANDIDATE_A })
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')

    // §F.2: the two-sided experiment evaluates a replacement of an existing
    // SKILL.md — promoting a brand-new skill is not what its evidence can show.
    // The refusal lands at prepare, before any sandbox or ledger write, so no
    // proposal can ever walk a new skill towards a promotion.
    await expect(svc.prepare('s1', 'root-1')).rejects.toThrow(/production skill .* does not exist/)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('s1')).status).toBe('candidate')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
    expect(await ledgerKinds(root)).not.toContain('prepared')
    expect(await ledgerKinds(root)).not.toContain('applied')
    expect(existsSync(skillProductionFile(skillRoot))).toBe(false)

    // Production created afterwards is left exactly as it is: nothing resumed
    // this candidate, and the refusal never touched production.
    const brandNew = skillText('# a brand new production skill')
    await productionSkill(skillRoot, brandNew)
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(brandNew)
    expect((await svc.get('s1')).status).toBe('candidate')
  })

  it('P3-D: a production target that became a directory, a file symlink, or an ancestor symlink is refused', async () => {
    const { svc, dir, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')

    const outside = join(dir, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'SKILL.md'), 'external content\n')

    // 1. the SKILL.md path becomes a directory
    await rm(skillProductionFile(skillRoot))
    await mkdir(skillProductionFile(skillRoot))
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('is no longer a readable regular file')
    await expect(svc.checkProductionBaseline('s1')).rejects.toThrow('is no longer a readable regular file')
    await rm(skillProductionFile(skillRoot), { recursive: true })

    // 2. the SKILL.md path becomes a symbolic link to a file outside the skill root
    await symlink(join(outside, 'SKILL.md'), skillProductionFile(skillRoot))
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('is a symbolic link')
    expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe('external content\n')
    await rm(skillProductionFile(skillRoot))

    // 3. an ancestor (the skill directory itself) becomes a symbolic link
    await rm(join(skillRoot, 'verify'), { recursive: true, force: true })
    await symlink(outside, join(skillRoot, 'verify'))
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('is a symbolic link')
    expect(await readFile(join(outside, 'SKILL.md'), 'utf8')).toBe('external content\n')

    // every refusal left the proposal decided with no applied record
    expect((await svc.get('s1')).status).toBe('decided')
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it('P3-E: two candidates from one champion apply serially; the second is refused and the first result stands', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)
    await walkSkillToDecided(svc, 's2', P3_CANDIDATE_B)
    // both were evaluated and approved against the same production baseline
    expect((await svc.get('s1')).prepared!.skillBaseline).toEqual((await svc.get('s2')).prepared!.skillBaseline)

    const { ctx, approval } = toolCtx(svc)
    const first = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(first).toContain('proposal s1 [applied] L2 skill verify')
    expect(approval.request).toHaveBeenCalledOnce()

    const second = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's2' }, exec('root-1'))) as string
    expect(second).toContain('evolution_apply rejected:')
    expect(second).toContain('changed since prepare')
    expect(second).toContain(P3_CONFLICT_GUIDANCE)
    // the second never reaches the human: one approval for the whole serial run
    expect(approval.request).toHaveBeenCalledOnce()

    // production keeps the first result; the second candidate changed nothing
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(P3_CANDIDATE_A)
    expect((await svc.get('s1')).status).toBe('applied')
    const stale = await svc.get('s2')
    expect(stale.status).toBe('decided')
    expect(stale.applied).toBeUndefined()
    expect(stale.prepared!.skillBaseline!.sha256).toBe(createHash('sha256').update(P3_BASELINE, 'utf8').digest('hex'))
    expect(stale.history.map(entry => entry.status)).toEqual(['proposed', 'candidate', 'prepared', 'gated', 'decided'])
    expect((await svc.readSkillCandidate('s2')).skillMd).toEqual(Buffer.from(P3_CANDIDATE_B, 'utf8'))
    expect((await ledgerKinds(root)).filter(kind => kind === 'applied')).toHaveLength(1)
  })

  it('P3-F: a baseline that moved before the human review is refused without asking for approval', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)
    await writeFile(skillProductionFile(skillRoot), '# moved before the review\n')

    const { ctx, approval } = toolCtx(svc)
    const result = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(result).toContain('evolution_apply rejected:')
    expect(result).toContain('changed since prepare')
    expect(approval.request).not.toHaveBeenCalled()
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe('# moved before the review\n')
  })

  it('P3-F: a baseline that moves while the approval is pending is refused by the recheck after the grant', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)

    // Controllable promises, no sleeps: the approval stub reports that the
    // human is deciding, then waits for the test to release the grant.
    let deciding: () => void = () => {}
    let grant: () => void = () => {}
    const humanDeciding = new Promise<void>(resolve => {
      deciding = resolve
    })
    const granted = new Promise<void>(resolve => {
      grant = resolve
    })
    const approval = {
      request: vi.fn(async () => {
        deciding()
        await granted
        return 'allowed-once' as const
      }),
    }
    const base = toolCtx(svc)
    const ctx = { ...(base.ctx as unknown as Record<string, unknown>), approval } as never
    const applying = defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))

    await humanDeciding
    await writeFile(skillProductionFile(skillRoot), '# moved while the human was deciding\n')
    grant()
    const result = (await applying) as string

    expect(approval.request).toHaveBeenCalledOnce()
    expect(result).toContain('evolution_apply rejected:')
    expect(result).toContain('changed since prepare')
    expect((await svc.get('s1')).status).toBe('decided')
    expect(await ledgerKinds(root)).not.toContain('applied')
    // production keeps the externally edited bytes — no overwrite, no merge
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe('# moved while the human was deciding\n')
  })

  it('P3-G: a reopened service identifies the same production-baseline conflict', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)
    await writeFile(skillProductionFile(skillRoot), '# moved across a restart\n')

    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    await expect(reopened.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('changed since prepare')
    await expect(reopened.checkProductionBaseline('s1')).rejects.toThrow('changed since prepare')
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe('# moved across a restart\n')
    const reloaded = await reopened.get('s1')
    expect(reloaded.status).toBe('decided')
    expect(reloaded.applied).toBeUndefined()
    expect(reloaded.prepared!.skillBaseline).toEqual({
      name: 'verify',
      sha256: createHash('sha256').update(P3_BASELINE, 'utf8').digest('hex'),
    })
    expect(reloaded.history.map(entry => entry.status)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'gated',
      'decided',
    ])
  })

  it('P3-G: a P2 content change is still refused next to the baseline check', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    const identity = await prepareSkill(svc)
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
    // the candidate bytes change while the production baseline stays identical
    await writeFile(skillCandidateFile(root), 'rewritten candidate\n')
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('no longer matches the content identity')
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(root)).not.toContain('applied')
  })

  it('K2: rollback restores the champion snapshot of the version this proposal applied, and refuses a target a later writer changed', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)
    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(applied.proposal.status).toBe('applied')
    expect(await ledgerKinds(root)).toEqual(expect.arrayContaining(['commit_intent', 'applied']))

    // A target that no longer carries what this proposal applied — here an
    // external edit, in practice a later proposal's apply — is not rolled back
    // over: rollback would restore a baseline on top of a version newer than the
    // one it is undoing. Nothing is written, no intent is recorded, and the
    // proposal stays applied with the external bytes untouched.
    await writeFile(skillProductionFile(skillRoot), '# edited after the apply\n')
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    await expect(svc.rollback('s1', 'root-1', 'approval:call-2')).rejects.toThrow(
      /does not hold the content proposal "s1" applied/,
    )
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe('# edited after the apply\n')
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('s1')).status).toBe('applied')
    expect((await svc.get('s1')).rolledback).toBeUndefined()
    expect(await svc.openIntentTargets()).toEqual([])

    // Put production back to exactly what this proposal applied and the
    // rollback goes through, restoring the prepare-time champion byte for byte.
    await writeFile(skillProductionFile(skillRoot), P3_CANDIDATE_A)
    const rolledback = await svc.rollback('s1', 'root-1', 'approval:call-2')
    expect(rolledback.proposal.status).toBe('rolledback')
    expect(await readFile(skillProductionFile(skillRoot))).toEqual(Buffer.from(P3_BASELINE, 'utf8'))
    expect((await svc.get('s1')).applied!.approvalRef).toBe('approval:call-1')
    expect((await svc.get('s1')).rolledback!.approvalRef).toBe('approval:call-2')
  })

  it('P3-G: a prepared record with no recorded baseline is refused at the entry instead of defaulting to match', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkSkillToDecided(svc, 's1', P3_CANDIDATE_A)
    // the P2-era shape: skillContent recorded, skillBaseline absent
    await dropBaselineField(root)
    const bytes = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })

    // The record never folds: a prepare without its production baseline is not a
    // shape this build's entries write, so there is no state an apply could be
    // reached from — and nothing defaults a missing baseline to a match.
    await expect(reopened.list()).rejects.toThrow('no valid skillBaseline identity')
    await expect(reopened.get('s1')).rejects.toThrow('no valid skillBaseline identity')
    await expect(reopened.checkProductionBaseline('s1')).rejects.toThrow('no valid skillBaseline identity')
    await expect(reopened.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('no valid skillBaseline identity')

    // The refusal costs nothing: no human is asked, production keeps its bytes
    // and the ledger keeps the malformed line byte for byte.
    const { ctx, approval } = toolCtx(reopened)
    const viaTool = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(viaTool).toContain('evolution_apply rejected:')
    expect(viaTool).toContain('no valid skillBaseline identity')
    expect(approval.request).not.toHaveBeenCalled()
    expect(await readFile(skillProductionFile(skillRoot), 'utf8')).toBe(P3_BASELINE)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(bytes)
  })

  it('P3-G: a malformed skillBaseline on a skill prepared record fails the fold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-forge-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    const forged = {
      formatVersion: 4,
      kind: 'prepared',
      proposalId: 's1',
      sandbox: 'sandbox/s1',
      mechanical: true,
      champion: 'captured',
      skillContent: { name: 'verify', sha256: 'a'.repeat(64) },
      files: ['x'],
      skillBaseline: { name: 'verify', sha256: 'not-a-digest' },
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    await expect(
      new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root }).list(),
    ).rejects.toThrow('no valid skillBaseline identity')
  })

  /**
   * A6/EVO-2: the composed identity a capability prepare freezes is three whole-file
   * digests of the deployment's table file — and nothing else of it, because that
   * file carries the deployment's credentials. A hand-forged line that gets one of
   * the three wrong is refused at the fold exactly as a live append would be.
   */
  it('A6: a malformed capabilityTable on a capability prepared record fails the fold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-forge-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(capabilityProposal, 'root-1')
    const entry = { preset: 'standard', skills: [CAPABILITY_FIXTURE_SKILL] }
    await svc.candidate('c1', VERSION_SET, 'root-1', { rows: { research: entry } })
    const forged = {
      formatVersion: 4,
      kind: 'prepared',
      proposalId: 'c1',
      sandbox: 'sandbox/c1',
      mechanical: true,
      champion: 'absent',
      capabilityRow: { name: 'research', entry, digest: digestOf(entry) },
      capabilityBaseline: null,
      capabilityTable: { baselineSha256: 'a'.repeat(64), applySha256: 'not-a-digest', rollbackSha256: 'b'.repeat(64) },
      files: ['x'],
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    await expect(
      new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root }).list(),
    ).rejects.toThrow('no valid capabilityTable.applySha256')
  })

  it('A6: a capabilityTable on a skill prepared record fails the fold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-forge-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    const forged = {
      formatVersion: 4,
      kind: 'prepared',
      proposalId: 's1',
      sandbox: 'sandbox/s1',
      mechanical: true,
      champion: 'captured',
      skillContent: { name: 'verify', sha256: 'a'.repeat(64) },
      skillBaseline: { name: 'verify', sha256: 'b'.repeat(64) },
      capabilityTable: { baselineSha256: 'a'.repeat(64), applySha256: 'a'.repeat(64), rollbackSha256: 'a'.repeat(64) },
      files: ['x'],
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    await expect(
      new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root }).list(),
    ).rejects.toThrow('capability table identity')
  })
})

import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EvolutionService } from '../../src/evolution.ts'
import type { ProposeInput } from '../../src/evolution.ts'
import { defineEvolutionCandidateTool } from '../../../agent-singularity/src/tools/evolution-candidate.ts'
import { defineEvolutionGateTool } from '../../../agent-singularity/src/tools/evolution-gate.ts'
import { defineEvolutionListTool } from '../../../agent-singularity/src/tools/evolution-list.ts'
import { defineEvolutionPrepareTool } from '../../../agent-singularity/src/tools/evolution-prepare.ts'
import { defineEvolutionProposeTool } from '../../../agent-singularity/src/tools/evolution-propose.ts'
import {
  service,
  skillProposal,
  VERSION_SET,
  proposal,
  refusalOf,
  skillText,
  serviceWithRoots,
  PRODUCTION_OLD,
  recordSkillExperiment,
  gateAnswers,
  reopenLike,
  FIXTURE_SELECTION,
  fixtureCtx,
  PRODUCTION_REPLACED,
  toolCtx,
  exec,
  PRODUCTION_V1,
  requireProductionSkill,
} from './evolution.fixture.ts'

const presetProposal: ProposeInput = {
  proposalId: 'pr1',
  targetType: 'agent_preset',
  targetId: 'bb-verify',
  baseVersion: 'v1',
  level: 'L3',
  rationale: 'the preset lacks the check skill',
  sourceRefs: ['diagnosis:d1'],
}

describe('EvolutionService mutation schemas', () => {
  it('accepts the skill mutation — the only candidate mutation this build admits', async () => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: 'new SKILL.md text' })
    expect((await svc.get('s1')).mutation).toEqual({ name: 'verify', content: 'new SKILL.md text' })
  })

  it.each([
    ['a name with a separator', { name: 'a/b', content: 'x' }, 'mutation.name'],
    ['a traversing name', { name: '..', content: 'x' }, 'mutation.name'],
    ['an empty content', { name: 'verify', content: ' ' }, 'mutation.content'],
    ['an unknown key', { name: 'verify', content: 'x', extra: 1 }, 'unknown key "extra"'],
  ])('rejects a skill mutation with %s', async (_label, mutation, message) => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    await expect(svc.candidate('s1', VERSION_SET, 'root-1', mutation)).rejects.toThrow(message as string)
    expect((await svc.get('s1')).status).toBe('proposed')
  })

  it('rejects a non-object mutation for the skill candidate', async () => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    for (const mutation of ['text', ['x'], null]) {
      await expect(svc.candidate('s1', VERSION_SET, 'root-1', mutation)).rejects.toThrow('mutation must be an object')
    }
  })
})

describe('EvolutionService candidate admission (S4-E 收尾, A6)', () => {
  it.each([
    ['agent_preset', presetProposal, { presetId: 'bb-verify', files: [{ path: 'preset.yml', content: 'x' }] }],
    ['task_definition', proposal, { baseVersion: 'v3', definition: { objective: 'new' } }],
  ] as const)('refuses an unsupported or malformed %s candidate before the first ledger write', async (targetType, input, mutation) => {
    const svc = await service()
    await svc.propose(input, 'root-1')
    const before = await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')

    const message = await refusalOf(svc.candidate(input.proposalId, VERSION_SET, 'root-1', mutation))
    if (targetType === 'task_definition') expect(message).toContain('unknown key "baseVersion"')
    else {
      expect(message).toContain('cannot become a candidate in this build')
      expect(message).toContain(`"${targetType}"`)
    }
    // Nothing was appended, nothing was materialized, and the proposal stays the
    // recorded suggestion it was.
    expect(await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).toBe(before)
    const proposalAfter = await svc.get(input.proposalId)
    expect(proposalAfter.status).toBe('proposed')
    expect(proposalAfter.mutation).toBeUndefined()
    expect(proposalAfter.history.map(entry => entry.status)).toEqual(['proposed'])
    expect(existsSync(join(svc.root, 'sandbox'))).toBe(false)
  })

  it('refuses a bookkeeping-only suggestion the same way, recording only the proposal', async () => {
    const svc = await service()
    await svc.propose(
      { ...proposal, proposalId: 'w1', targetType: 'workflow_policy', targetId: 'workflow:1' },
      'root-1',
    )
    const message = await refusalOf(svc.candidate('w1', VERSION_SET, 'root-1', { sketch: 'free-form' }))
    expect(message).toContain('cannot become a candidate in this build')
    expect((await svc.get('w1')).status).toBe('proposed')
  })

  it('still lets a skill candidate carry the structured mutation', async () => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    const recorded = await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    expect(recorded.status).toBe('candidate')
    expect(recorded.mutation).toEqual({ name: 'verify', content: skillText('x') })
  })
})

describe('EvolutionService prepared state machine', () => {
  it('walks candidate(mutation) → prepared → the recorded experiment → gated → decided for a skill candidate', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: skillText('new') })
    const evidenceFile = join(root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await svc.prepare('s1', 'root-1')
    const { reportPath, experimentId } = await recordSkillExperiment(svc, 's1')
    // The evaluation is the experiment family, not a lifecycle transition: the
    // proposal stays prepared, with a completed experiment beside it.
    expect((await svc.get('s1')).status).toBe('prepared')
    expect(experimentId).toMatch(/^[a-f0-9]{16}$/)
    expect(JSON.parse(await readFile(join(root, reportPath), 'utf8')).proposalId).toBe('s1')
    await svc.gate('s1', gateAnswers([evidenceFile, reportPath]), 'root-1')
    const decided = await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-1')
    expect(decided.status).toBe('decided')
    expect(decided.history.map(entry => entry.status)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'gated',
      'decided',
    ])
  })

  it('rejects gate on a mutation-carrying candidate until it is prepared', async () => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await expect(svc.gate('s1', gateAnswers(['/x']), 'root-1')).rejects.toThrow(/cannot record "gated".*prepared/)
    expect((await svc.get('s1')).status).toBe('candidate')
  })

  it('refuses a mutation-less candidate, and a repeated prepare', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
    await svc.propose(skillProposal, 'root-1')
    // §F.2: no shell flow. A candidate carrying nothing to materialize and
    // evaluate is refused before the first candidate line, so no later entry
    // has anything to reach.
    await expect(svc.candidate('s1', VERSION_SET, 'root-1', undefined)).rejects.toThrow('mutation must be an object')
    expect((await svc.get('s1')).status).toBe('proposed')
    await svc.propose({ ...skillProposal, proposalId: 's2' }, 'root-1')
    await svc.candidate('s2', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await svc.prepare('s2', 'root-1')
    await expect(svc.prepare('s2', 'root-1')).rejects.toThrow('cannot record "prepared"')
  })
})

describe('EvolutionService sandbox materialization', () => {
  it('materializes a skill mutation and snapshots the champion SKILL.md', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: skillText('new skill text') })
    const prepared = await svc.prepare('s1', 'root-1')
    expect(prepared.status).toBe('prepared')
    expect(prepared.prepared).toEqual({
      sandbox: 'sandbox/s1',
      mechanical: true,
      champion: 'captured',
      // P2: the identity is the SHA-256 of the exact materialized bytes
      skillContent: {
        name: 'verify',
        sha256: createHash('sha256').update(skillText('new skill text'), 'utf8').digest('hex'),
      },
      // P3: the production baseline digest, from the same read as the snapshot
      skillBaseline: { name: 'verify', sha256: createHash('sha256').update(PRODUCTION_OLD, 'utf8').digest('hex') },
      files: ['skills/verify/SKILL.md', 'champion/skills/verify/SKILL.md'],
    })
    expect(await readFile(join(root, 'sandbox', 's1', 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe(
      skillText('new skill text'),
    )
    expect(await readFile(join(root, 'sandbox', 's1', 'champion', 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe(
      PRODUCTION_OLD,
    )
  })

  it('snapshots the exact production bytes used for the baseline digest', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    // A loadable production object (K3: prepare reads it through the loader)
    // whose bytes are compared exactly at the end, so "the digest is the
    // snapshot's" cannot be read off two different reads.
    const bytes = Buffer.from(skillText('# the production bytes the champion must be'), 'utf8')
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), bytes)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('new') })
    const prepared = await svc.prepare('s1', 'root-1')
    expect(prepared.prepared?.skillBaseline?.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(await readFile(join(root, 'sandbox', 's1', 'champion', 'skills', 'verify', 'SKILL.md'))).toEqual(bytes)
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'))).toEqual(bytes)
  })

  it('refuses a prepare whose production skill does not exist, writing nothing', async () => {
    const { svc, root } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('new') })
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')

    // §F.2: this build prepares and promotes a replacement of an existing
    // single-file SKILL.md. A target that is not there has nothing to replace,
    // so it is refused before any sandbox or ledger write — the rejection names
    // the missing production file.
    await expect(svc.prepare('s1', 'root-1')).rejects.toThrow(/production skill .*verify\/SKILL\.md" does not exist/)
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('s1')).status).toBe('candidate')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
  })

  it('confines every write to the sandbox dir; production roots stay untouched', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: skillText('new skill text') })
    await svc.prepare('s1', 'root-1')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_OLD)
    expect((await readdir(root)).sort()).toEqual(['proposals.jsonl', 'sandbox'])
    expect(await readdir(join(root, 'sandbox'))).toEqual(['s1'])
  })

  it('rejects an unsafe proposalId at prepare time, writing nothing', async () => {
    const { svc, root } = await serviceWithRoots()
    await svc.propose({ ...skillProposal, proposalId: '../escape' }, 'root-1')
    await svc.candidate('../escape', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await expect(svc.prepare('../escape', 'root-1')).rejects.toThrow('proposalId')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
    expect((await svc.get('../escape')).status).toBe('candidate')
  })
})

describe('EvolutionService fold on read-back', () => {
  it('replays a ledger with prepared records to the same fold as the live service', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: skillText('new') })
    await svc.prepare('s1', 'root-1')
    const live = await svc.list()
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    expect(await reopened.list()).toEqual(live)
    expect((await reopened.get('s1')).prepared).toEqual({
      sandbox: 'sandbox/s1',
      mechanical: true,
      champion: 'captured',
      // P2: the content identity survives the reopen unchanged
      skillContent: { name: 'verify', sha256: createHash('sha256').update(skillText('new'), 'utf8').digest('hex') },
      // P3: and so does the production baseline digest
      skillBaseline: { name: 'verify', sha256: createHash('sha256').update(PRODUCTION_OLD, 'utf8').digest('hex') },
      files: ['skills/verify/SKILL.md', 'champion/skills/verify/SKILL.md'],
    })
  })

  it('fails loud when a prepared record lies about mechanical', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    const forged = {
      formatVersion: 4,
      kind: 'prepared',
      proposalId: 's1',
      sandbox: 'sandbox/s1',
      mechanical: false,
      champion: 'captured',
      files: ['x'],
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root })
    await expect(reopened.list()).rejects.toThrow('mechanical')
  })

  it('fails loud on a forged candidate or gated record: the fold reruns the write-path payload checks', async () => {
    // an empty version set would never survive candidate() — and a candidate is
    // only a skill candidate here, so the forged line rides a skill proposal
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(skillProposal, 'root-1')
    const forgedCandidate = {
      formatVersion: 4,
      kind: 'candidate',
      proposalId: 's1',
      versionSet: {},
      mutation: { name: 'verify', content: skillText('x') },
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forgedCandidate)}\n`, { flag: 'a' })
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root })
    await expect(reopened.list()).rejects.toThrow('at least one version')

    // an empty gate answer would never survive gate()
    const root2 = await mkdtemp(join(tmpdir(), 'evolution-'))
    const skillRoot2 = join(root2, 'skills')
    await mkdir(join(skillRoot2, 'verify'), { recursive: true })
    await writeFile(join(skillRoot2, 'verify', 'SKILL.md'), PRODUCTION_REPLACED)
    const svc2 = new EvolutionService(fixtureCtx(), {
      modelSelection: () => FIXTURE_SELECTION,
      root: root2,
      skillRoot: skillRoot2,
    })
    await svc2.propose(skillProposal, 'root-1')
    await svc2.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    // A gated record is legal only after the one transition a candidate admits,
    // so the live entries walk to prepared and the forged line lands on top.
    await svc2.prepare('s1', 'root-1')
    const emptyAnswer = {
      formatVersion: 4,
      kind: 'gated',
      proposalId: 's1',
      gate: { ...gateAnswers(['ev-1']), targetFailureFixed: '' },
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root2, 'proposals.jsonl'), `${JSON.stringify(emptyAnswer)}\n`, { flag: 'a' })
    const reopened2 = new EvolutionService(fixtureCtx(), {
      modelSelection: () => FIXTURE_SELECTION,
      root: root2,
      skillRoot: skillRoot2,
    })
    await expect(reopened2.list()).rejects.toThrow('Target failure fixed')

    // zero regression evidence refs would never survive gate() either
    const root3 = await mkdtemp(join(tmpdir(), 'evolution-'))
    const skillRoot3 = join(root3, 'skills')
    await mkdir(join(skillRoot3, 'verify'), { recursive: true })
    await writeFile(join(skillRoot3, 'verify', 'SKILL.md'), PRODUCTION_REPLACED)
    const svc3 = new EvolutionService(fixtureCtx(), {
      modelSelection: () => FIXTURE_SELECTION,
      root: root3,
      skillRoot: skillRoot3,
    })
    await svc3.propose(skillProposal, 'root-1')
    await svc3.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await svc3.prepare('s1', 'root-1')
    const noEvidence = {
      formatVersion: 4,
      kind: 'gated',
      proposalId: 's1',
      gate: gateAnswers([]),
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root3, 'proposals.jsonl'), `${JSON.stringify(noEvidence)}\n`, { flag: 'a' })
    const reopened3 = new EvolutionService(fixtureCtx(), {
      modelSelection: () => FIXTURE_SELECTION,
      root: root3,
      skillRoot: skillRoot3,
    })
    await expect(reopened3.list()).rejects.toThrow('at least one evidence ref')
  })
})

describe('evolution_prepare tool', () => {
  it('evolution_candidate accepts a structured skill mutation and points at evolution_prepare', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    const result = (await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: { skill: 'v2' },
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
      },
      exec('root-1'),
    )) as string
    expect(result).toContain('[candidate] version set: skill=v2')
    expect(result).toContain('next: evolution_prepare')
    expect((await svc.get('s1')).mutation).toEqual({ name: 'verify', content: skillText('# new') })
  })

  it('evolution_candidate surfaces a schema violation without recording', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    const result = (await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 's1', versionSet: VERSION_SET, mutationJson: JSON.stringify({ name: 'a/b', content: 'x' }) },
      exec('root-1'),
    )) as string
    expect(result).toContain('evolution_candidate rejected:')
    expect(result).toContain('mutation.name')
    expect((await svc.get('s1')).status).toBe('proposed')
  })

  it('evolution_prepare materializes the skill candidate and snapshots the champion SKILL.md', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
      },
      exec('root-1'),
    )
    const result = (await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(result).toContain('proposal s1 [prepared]')
    expect(result).toContain('wrote skills/verify/SKILL.md')
    expect(result).toContain('champion snapshot: captured under champion/')
    expect(result).toContain('production baseline: verify sha256:')
    expect(result).toContain('production was not touched')
    expect(await readFile(join(svc.root, 'sandbox', 's1', 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe(
      skillText('# new'),
    )
    expect(await readFile(join(svc.root, 'sandbox', 's1', 'champion', 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe(
      PRODUCTION_V1,
    )
  })

  it('evolution_prepare refuses a production skill that does not exist, writing nothing', async () => {
    const { svc, root } = await serviceWithRoots()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
      },
      exec('root-1'),
    )
    const before = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const result = (await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(result).toContain('evolution_prepare rejected:')
    expect(result).toContain('does not exist')
    expect(result).toContain('a new skill cannot be evaluated or promoted by this path')
    expect(result).not.toContain('create the skill in production')
    // No sandbox and no ledger line: the refusal lands before the first write.
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
    expect((await svc.get('s1')).status).toBe('candidate')
  })

  it('evolution_prepare rejects an unknown proposal, and a candidate the entry never accepted', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionPrepareTool(ctx)
    const missing = (await tool.execute({ proposalId: 'ghost' }, exec('root-1'))) as string
    expect(missing).toContain('evolution_prepare rejected:')
    expect(missing).toContain('unknown proposal "ghost"')
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    // The candidate tool's schema requires `mutationJson`, so a call carrying none
    // is refused before the tool body runs and never reaches the ledger.
    await expect(
      defineEvolutionCandidateTool(ctx).execute({ proposalId: 's1', versionSet: VERSION_SET }, exec('root-1')),
    ).rejects.toThrow('missing required property "mutationJson"')
    expect((await svc.get('s1')).status).toBe('proposed')
    const result = (await tool.execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(result).toContain('cannot record "prepared"')
    expect((await svc.get('s1')).status).toBe('proposed')
  })

  it('evolution_gate rejects a mutation-carrying candidate until it is prepared', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
      },
      exec('root-1'),
    )
    const result = (await defineEvolutionGateTool(ctx).execute(
      { proposalId: 's1', ...gateAnswers(['ev-1']) },
      exec('root-1'),
    )) as string
    expect(result).toContain('cannot record "gated"')
    expect(result).toContain('evolution_prepare')
    expect((await svc.get('s1')).status).toBe('candidate')
  })

  it('evolution_list renders the prepared status with sandbox path and champion state', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
      },
      exec('root-1'),
    )
    await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    const list = defineEvolutionListTool(ctx)
    const all = (await list.execute({}, exec('root-1'))) as string
    expect(all).toContain('- s1 [prepared] L2 skill verify (base v1)')
    expect(all).toContain('mutation: skill mutation recorded')
    expect(all).toContain(`sandbox: ${svc.root}/sandbox/s1 (2 files, guidance (SKILL.md), champion snapshot captured`)
    expect(all).not.toContain('mechanical')
    expect(all).not.toContain('champion: null')
    expect(all).toContain('history: proposed by root-1')
    const filtered = (await list.execute({ status: 'prepared' }, exec('root-1'))) as string
    expect(filtered).toContain('evolution ledger (1):')
    const gated = (await list.execute({ status: 'gated' }, exec('root-1'))) as string
    expect(gated).toBe('evolution ledger: no proposals match')
  })
})

describe('EvolutionService: the two-sided experiment is the gate evidence', () => {
  it('requires the gate of a skill candidate to cite its experiment report, and the report to still exist', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await requireProductionSkill(skillRoot)
    await svc.prepare('s1', 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    const evidenceFile = join(root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await expect(svc.gate('s1', gateAnswers([evidenceFile]), 'root-1')).rejects.toThrow(
      `must cite its experiment report "${reportPath}"`,
    )
    await svc.gate('s1', gateAnswers([evidenceFile, reportPath]), 'root-1')
    expect((await svc.get('s1')).status).toBe('gated')
  })

  it('fails the gate when the experiment report was deleted after the experiment', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    const { rm } = await import('node:fs/promises')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await requireProductionSkill(skillRoot)
    await svc.prepare('s1', 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    await rm(join(root, reportPath))
    await expect(svc.gate('s1', gateAnswers([reportPath]), 'root-1')).rejects.toThrow(
      'no longer exists under the ledger root',
    )
  })

  it('gates a skill candidate on a completed experiment only', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await requireProductionSkill(skillRoot)
    await svc.prepare('s1', 'root-1')
    await expect(svc.gate('s1', gateAnswers(['sandbox/s1/replay-report.json']), 'root-1')).rejects.toThrow(
      'has no two-sided experiment',
    )
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it('folds a ledger holding a recorded experiment back to the same view after reopen', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await svc.prepare('s1', 'root-1')
    await recordSkillExperiment(svc, 's1')
    const live = await svc.list()
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    expect(await reopened.list()).toEqual(live)
    // The evaluation is not a lifecycle transition: the proposal is prepared, and
    // the experiment family folds back beside it.
    expect((await reopened.get('s1')).status).toBe('prepared')
    expect((await reopened.experiments('s1')).map(view => view.experimentId)).toHaveLength(1)
  })
})

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EvolutionService } from '../../src/evolution.ts'
import { defineEvolutionCandidateTool } from '../../../agent-singularity/src/tools/evolution-candidate.ts'
import { defineEvolutionDecideTool } from '../../../agent-singularity/src/tools/evolution-decide.ts'
import { defineEvolutionGateTool } from '../../../agent-singularity/src/tools/evolution-gate.ts'
import { defineEvolutionListTool } from '../../../agent-singularity/src/tools/evolution-list.ts'
import { defineEvolutionPrepareTool } from '../../../agent-singularity/src/tools/evolution-prepare.ts'
import { defineEvolutionProposeTool } from '../../../agent-singularity/src/tools/evolution-propose.ts'
import {
  serviceWithRoots,
  PRODUCTION_V1,
  skillProposal,
  VERSION_SET,
  skillText,
  recordSkillExperiment,
  gateAnswers,
  service,
  proposal,
  reopenLike,
  FIXTURE_SELECTION,
  fixtureCtx,
  toolCtx,
  exec,
  serviceWithProduction,
  capabilityProposal,
} from './evolution.fixture.ts'

describe('EvolutionService ledger', () => {
  it('walks proposed → candidate → prepared → gated → decided and derives history from appended records', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# new') })
    await svc.prepare('s1', 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([reportPath]), 'root-1')
    const decided = await svc.decide(
      's1',
      'KEEP_FOR_FURTHER_RESEARCH',
      'root-1',
      'approval:call-1',
      'approved by human',
    )
    expect(decided.status).toBe('decided')
    expect(decided.decision).toBe('KEEP_FOR_FURTHER_RESEARCH')
    expect(decided.decisionNote).toBe('approved by human')
    expect(decided.decisionApprovalRef).toBe('approval:call-1')
    expect(decided.history.map(entry => entry.status)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'gated',
      'decided',
    ])
  })

  it('rejects state-machine skips: gate on proposed, promote before gate, candidate twice', async () => {
    const { svc } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await expect(svc.gate('s1', gateAnswers(['/x']), 'root-1')).rejects.toThrow('cannot record "gated"')
    await expect(svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "decided"')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await expect(
      svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') }),
    ).rejects.toThrow('cannot record "candidate"')
    await expect(svc.propose(skillProposal, 'root-1')).rejects.toThrow('already exists')
    // and an unprepared candidate cannot gate: prepared is the one next state
    await expect(svc.gate('s1', gateAnswers(['/x']), 'root-1')).rejects.toThrow(
      /cannot record "gated".*evolution_prepare/,
    )
  })

  it.each(
    (['REJECT', 'KEEP_FOR_FURTHER_RESEARCH'] as const).flatMap(decision =>
      (['proposed', 'candidate', 'prepared'] as const).map(stage => ({ decision, stage })),
    ),
  )('settles $stage with $decision and a reason without an experiment or production write', async ({ decision, stage }) => {
    const { svc, skillRoot } = await serviceWithProduction()
    const skillPath = join(skillRoot, 'verify', 'SKILL.md')
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(skillPath, PRODUCTION_V1)
    await svc.propose(skillProposal, 'root-1')
    if (stage !== 'proposed')
      await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: PRODUCTION_V1 })
    if (stage === 'prepared') await svc.prepare('s1', 'root-1')

    for (const note of [undefined, ' ', ''])
      await expect(svc.decide('s1', decision, 'root-1', 'approval:call-1', note)).rejects.toThrow('requires a reason in note')
    await expect(svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-1', 'same bytes')).rejects.toThrow('cannot record "decided"')
    await expect(svc.decide('s1', decision, 'root-1', '', 'same bytes')).rejects.toThrow('approvalRef')
    expect((await svc.get('s1')).status).toBe(stage)

    const note = 'Candidate matches the available Skill; retain the existing experience and explore a new task.'
    const settled = await svc.decide('s1', decision, 'root-1', 'approval:call-1', note)
    expect(settled).toMatchObject({ status: 'decided', decision, decisionNote: note, decisionApprovalRef: 'approval:call-1' })
    expect(settled.gate).toBeUndefined()
    expect(await svc.experiments('s1')).toEqual([])
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root: svc.root, skillRoot })
    expect(await reopened.get('s1')).toEqual(settled)
    await expect(reopened.apply('s1', 'root-1', 'approval:apply')).rejects.toThrow('cannot record "applied"')
    await expect(reopened.prepare('s1', 'root-1')).rejects.toThrow('cannot record "prepared"')
    await expect(reopened.decide('s1', 'PROMOTE', 'root-1', 'approval:again')).rejects.toThrow('cannot record "decided"')
    expect(await readFile(skillPath, 'utf8')).toBe(PRODUCTION_V1)
  })

  it('rejects moves on an unknown proposal id', async () => {
    const svc = await service()
    await expect(
      svc.candidate('ghost', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') }),
    ).rejects.toThrow('unknown proposal "ghost"')
    await expect(svc.get('ghost')).rejects.toThrow('unknown proposal "ghost"')
  })

  it('enforces required fields: baseVersion, level, at least one sourceRef', async () => {
    const svc = await service()
    await expect(svc.propose({ ...proposal, baseVersion: ' ' }, 'root-1')).rejects.toThrow('baseVersion')
    await expect(svc.propose({ ...proposal, level: 'L9' as never }, 'root-1')).rejects.toThrow('unknown level')
    await expect(svc.propose({ ...proposal, sourceRefs: [] }, 'root-1')).rejects.toThrow('at least one source')
    await expect(svc.propose({ ...proposal, sourceRefs: ['ok', ''] }, 'root-1')).rejects.toThrow('sourceRefs[1]')
  })

  it('enforces a complete non-empty version set on candidate', async () => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    const mutation = { name: 'verify', content: skillText('x') }
    await expect(svc.candidate('s1', {}, 'root-1', mutation)).rejects.toThrow('at least one version')
    await expect(svc.candidate('s1', { verifier: ' ' }, 'root-1', mutation)).rejects.toThrow('versionSet["verifier"]')
    await expect(svc.candidate('s1', { verifier: 1 as never }, 'root-1', mutation)).rejects.toThrow(
      'versionSet["verifier"]',
    )
  })

  it('requires all six gate answers and existence-checked regression evidence refs', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await svc.prepare('s1', 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    await expect(svc.gate('s1', { ...gateAnswers([reportPath]), targetFailureFixed: '' }, 'root-1')).rejects.toThrow(
      'Target failure fixed',
    )
    await expect(svc.gate('s1', gateAnswers([]), 'root-1')).rejects.toThrow('at least one evidence ref')
    await expect(svc.gate('s1', gateAnswers([reportPath, 'no/such/path.log']), 'root-1')).rejects.toThrow(
      'no known evidence id and no existing path',
    )
    // a resolver id (task-store evidence) also satisfies existence — checked, never executed
    await svc.gate('s1', gateAnswers([reportPath, 'evidence-r1-abc']), 'root-1', async ref => ref === 'evidence-r1-abc')
    expect((await svc.get('s1')).status).toBe('gated')
  })

  it('requires human-approval evidence on decide and records it on the ledger line', async () => {
    const { svc, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await svc.prepare('s1', 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([reportPath]), 'root-1')
    await expect(svc.decide('s1', 'KEEP_FOR_FURTHER_RESEARCH', 'root-1', '')).rejects.toThrow('approvalRef')
    expect((await svc.get('s1')).status).toBe('gated')
    await svc.decide('s1', 'KEEP_FOR_FURTHER_RESEARCH', 'root-1', 'approval:call-1', 'approved by human')
    const lines = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: 'decided', approvalRef: 'approval:call-1' })
    expect((await svc.get('s1')).decisionApprovalRef).toBe('approval:call-1')
    // and the fold after reopen keeps the ref
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root: svc.root, skillRoot })
    expect((await reopened.get('s1')).decisionApprovalRef).toBe('approval:call-1')
  })

  it('is append-only and immutable: duplicate ids rejected, replay after reopen matches the live fold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const first = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await first.propose(skillProposal, 'root-1')
    await first.propose({ ...proposal, proposalId: 'p2', targetType: 'verifier', level: 'L4' }, 'root-1')
    await first.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('x') })
    await expect(first.propose(skillProposal, 'root-1')).rejects.toThrow('already exists')
    const live = await first.list()
    // three lines on disk, one per record, never rewritten
    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map(line => (JSON.parse(line) as { kind: string }).kind)).toEqual([
      'proposed',
      'proposed',
      'candidate',
    ])
    // close: drain writes, reopen a fresh service on the same root, replay must fold to the same state
    const reopened = reopenLike(first, { modelSelection: () => FIXTURE_SELECTION, root })
    expect(await reopened.list()).toEqual(live)
    expect((await reopened.get('s1')).status).toBe('candidate')
    expect((await reopened.get('p2')).level).toBe('L4')
  })

  it('announces each durable append with its proposal, and nothing when the write refuses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const changes: string[] = []
    const ctx = fixtureCtx() as unknown as { emit: (name: string, payload: { proposalId: string }) => void }
    ctx.emit = (name, payload) => {
      if (name === 'evolution/change') changes.push(payload.proposalId)
    }
    const svc = new EvolutionService(ctx as never, { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(proposal, 'root-1')
    expect(changes).toEqual(['p1'])
    // A refused write announced nothing: the duplicate never reached the ledger.
    await expect(svc.propose(proposal, 'root-1')).rejects.toThrow('already exists')
    expect(changes).toEqual(['p1'])
  })

  it('fails loudly on a corrupt ledger line instead of silently drifting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(proposal, 'root-1')
    await writeFile(join(root, 'proposals.jsonl'), 'not json\n', { flag: 'a' })
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root })
    await expect(reopened.list()).rejects.toThrow('corrupt ledger line 2')
  })

  it('fails loudly when a hand-written line violates the state machine on read-back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { modelSelection: () => FIXTURE_SELECTION, root })
    await svc.propose(proposal, 'root-1')
    const forged = { formatVersion: 4, kind: 'decided', proposalId: 'p1', decision: 'PROMOTE', actor: 'x', at: 'now' }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root })
    await expect(reopened.list()).rejects.toThrow('cannot record "decided"')
  })
})

describe('evolution tools', () => {
  it('evolution_propose registers manually and records a suggestion', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionProposeTool(ctx)
    const result = (await tool.execute({ ...proposal }, exec('root-1'))) as string
    expect(result).toContain('proposal p1 registered [proposed] L2 task_definition build:1 (base v3)')
    expect(result).toContain('ledger entry only')
    expect((await svc.get('p1')).status).toBe('proposed')
  })

  /** The next-step line follows the two candidate kinds this build supports. */
  it('evolution_propose points skill and capability proposals at evolution_candidate', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionProposeTool(ctx)
    const suggestion = (await tool.execute(
      {
        proposalId: 'cap-suggestion',
        targetType: 'capability',
        targetId: 'research',
        baseVersion: '1',
        level: 'L2',
        rationale: 'record a suggestion',
        sourceRefs: ['diagnosis:d1'],
      },
      exec('root-1'),
    )) as string
    expect(suggestion).toContain('proposal cap-suggestion registered [proposed] L2 capability research (base 1)')
    expect(suggestion).toContain('next: evolution_candidate')
    expect(suggestion).toContain('exactly one whole capability row')
    expect(suggestion).not.toContain('next: evolution_prepare')
    expect((await svc.get('cap-suggestion')).status).toBe('proposed')

    const replacement = (await tool.execute({ ...skillProposal }, exec('root-1'))) as string
    expect(replacement).toContain('next: evolution_candidate')

    // The next-step line is wording, not a lifecycle: both proposals still hold
    // only their own `proposed` line until evolution_candidate is called.
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(kinds).toEqual(['proposed', 'proposed'])
    expect(existsSync(join(svc.root, 'sandbox'))).toBe(false)
  })

  it('evolution_propose transcribes from a recorded diagnosis and refuses mixed input', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionProposeTool(ctx)
    const result = (await tool.execute(
      { proposalId: 'p1', level: 'L2', baseVersion: 'v3', fromDiagnosis: { diagnosisId: 'd1', proposalIndex: 0 } },
      exec('root-1'),
    )) as string
    expect(result).toContain('task_definition build:1')
    const saved = await svc.get('p1')
    expect(saved.rationale).toBe('add empty-input fixture')
    expect(saved.sourceRefs).toEqual(['diagnosis:d1'])
    await expect(
      tool.execute(
        {
          proposalId: 'p2',
          level: 'L2',
          baseVersion: 'v3',
          targetId: 'x',
          fromDiagnosis: { diagnosisId: 'd1', proposalIndex: 0 },
        },
        exec('root-1'),
      ),
    ).rejects.toThrow('do not pass both')
    const missing = (await tool
      .execute({ proposalId: 'p2', level: 'L2', baseVersion: 'v3' }, exec('root-1'))
      .catch((error: Error) => String(error))) as string
    expect(missing).toContain('required without fromDiagnosis')
  })

  /**
   * The other half of A5's open vocabulary: a diagnosis may carry any target
   * type, and Evolution — which owns the mutation surfaces it can execute —
   * re-validates at the conversion entry. A transcription it cannot execute is
   * refused by name, before the ledger is touched, so a suggestion no executor
   * can take up never becomes an EvolutionProposal.
   */
  it('evolution_propose refuses a diagnosis proposal whose target type it cannot execute, with zero ledger writes', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionProposeTool(ctx)
    expect(existsSync(join(svc.root, 'proposals.jsonl'))).toBe(false)

    const rejected = (await tool
      .execute(
        {
          proposalId: 'p-unsupported',
          level: 'L2',
          baseVersion: 'v3',
          fromDiagnosis: { diagnosisId: 'd-unknown', proposalIndex: 0 },
        },
        exec('root-1'),
      )
      .catch((error: Error) => String(error))) as string
    expect(rejected).toContain('prompt_template')
    expect(rejected).toContain('d-unknown')
    expect(rejected).toContain('targetType')

    // Nothing was recorded: no proposal, no ledger line, no sandbox.
    expect(await svc.list()).toEqual([])
    expect(existsSync(join(svc.root, 'proposals.jsonl'))).toBe(false)
    expect(existsSync(join(svc.root, 'sandbox'))).toBe(false)
  })

  it('evolution_propose rejects a targetType outside the frozen vocabulary', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionProposeTool(ctx)
    const rejected = (await tool
      .execute({ ...proposal, targetType: 'prompt' }, exec('root-1'))
      .catch((error: Error) => String(error))) as string
    expect(rejected).toContain('targetType')
    expect(await svc.list()).toEqual([])
  })

  it('evolution tools reject a call carrying no agent identity', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await expect(defineEvolutionProposeTool(ctx).execute({ ...proposal }, {} as never)).rejects.toThrow(
      'missing agent id',
    )
    await expect(
      defineEvolutionCandidateTool(ctx).execute(
        {
          proposalId: 'p1',
          versionSet: VERSION_SET,
          mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
        },
        {} as never,
      ),
    ).rejects.toThrow('missing agent id')
    await expect(defineEvolutionPrepareTool(ctx).execute({ proposalId: 'p1' }, {} as never)).rejects.toThrow(
      'missing agent id',
    )
    expect(await svc.list()).toEqual([])
  })

  it('evolution_candidate and evolution_prepare move the skill proposal and stay ledger-only', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    const candidate = (await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new') }),
      },
      exec('root-1'),
    )) as string
    expect(candidate).toContain('[candidate] version set: taskDefinition=v3, verifier=v1')
    const prepared = (await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(prepared).toContain('[prepared] sandbox:')
    expect(prepared).toContain('next: evolution_replay')
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it('evolution_candidate refuses a mutation of the shape this build does not write, recording nothing', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    const before = await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')
    // The old bookkeeping shape matches neither candidate kind, so the service
    // refuses it before the ledger is reached.
    const rejected = (await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ baseVersion: 'v3', definition: { objective: 'x' } }),
      },
      exec('root-1'),
    )) as string
    expect(rejected).toContain('evolution_candidate rejected:')
    expect(rejected).toContain('skill mutation has unknown key "baseVersion"')
    expect(await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('s1')).status).toBe('proposed')
  })

  it('evolution_candidate takes a capability mutation of the one-whole-row shape through the model surface', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...capabilityProposal }, exec('root-1'))
    const accepted = (await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 'c1',
        versionSet: { capabilityTable: 'config.yml#doc1' },
        mutationJson: JSON.stringify({ rows: { research: { skills: ['verify'], tools: ['filesystem'] } } }),
      },
      exec('root-1'),
    )) as string
    expect(accepted).toContain('[candidate]')
    expect(accepted).toContain('evolution_prepare')
    const stored = await svc.get('c1')
    expect(stored.status).toBe('candidate')
    expect(stored.mutation).toEqual({ rows: { research: { skills: ['verify'], tools: ['filesystem'] } } })
  })

  it('evolution_gate rejects evidence refs unknown to the task store and the disk', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
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
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    const result = (await defineEvolutionGateTool(ctx).execute(
      { proposalId: 's1', ...gateAnswers([reportPath, 'ev-ghost']) },
      exec('root-1'),
    )) as string
    expect(result).toContain('evolution_gate rejected:')
    expect(result).toContain('ev-ghost')
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it('evolution_decide records only after a human approve through the native approval seam', async () => {
    // A skill candidate: the one target type whose PROMOTE this build grants.
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    const { ctx, approval } = toolCtx(svc, 'allowed-once')
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('# new verify skill') }),
      },
      exec('root-1'),
    )
    await defineEvolutionPrepareTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    const { reportPath } = await recordSkillExperiment(svc, 's1')
    await defineEvolutionGateTool(ctx).execute({ proposalId: 's1', ...gateAnswers([reportPath]) }, exec('root-1'))
    const result = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 's1', decision: 'PROMOTE', note: 'looks right' },
      exec('root-1'),
    )) as string
    expect(approval.request).toHaveBeenCalledOnce()
    const request = approval.request.mock.calls[0]![0] as { reason: string; toolName: string }
    expect(request.toolName).toBe('evolution_decide')
    expect(request.reason).toContain('proposal s1')
    expect(request.reason).toContain(
      `3. Existing regression maintained? full suite replayed green [evidence: ${reportPath}]`,
    )
    expect(request.reason).toContain('proposed decision: PROMOTE — looks right')
    expect(result).toContain('proposal s1 [decided] PROMOTE — looks right')
    expect(result).toContain('nothing applied yet; evolution_apply (second human gate) takes it to production')
    expect((await svc.get('s1')).status).toBe('decided')
    // the decided ledger line carries the approval call id, the applied/rolledback shape
    const lines = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: 'decided', approvalRef: 'approval:call-1' })
  })

  it.each(['rejected', 'cancelled', 'unavailable'])(
    'evolution_decide records nothing when the approval comes back %s',
    async outcome => {
      const { svc, skillRoot } = await serviceWithProduction()
      await mkdir(join(skillRoot, 'verify'), { recursive: true })
      await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
      const { ctx, approval } = toolCtx(svc, outcome)
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
      const { reportPath } = await recordSkillExperiment(svc, 's1')
      await defineEvolutionGateTool(ctx).execute({ proposalId: 's1', ...gateAnswers([reportPath]) }, exec('root-1'))
      const result = (await defineEvolutionDecideTool(ctx).execute(
        { proposalId: 's1', decision: 'REJECT' },
        exec('root-1'),
      )) as string
      expect(approval.request).toHaveBeenCalledOnce()
      expect(result).toContain('no decision recorded')
      expect(result).toContain('stays gated')
      expect((await svc.get('s1')).status).toBe('gated')
      const lines = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      expect(
        lines.map(line => (JSON.parse(line) as { kind: string }).kind).filter(kind => !kind.startsWith('experiment_')),
      ).toEqual(['proposed', 'candidate', 'prepared', 'gated'])
    },
  )

  it('evolution_decide refuses an ungated PROMOTE before asking for approval', async () => {
    const svc = await service()
    const { ctx, approval } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...proposal }, exec('root-1'))
    const result = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 'p1', decision: 'PROMOTE' },
      exec('root-1'),
    )) as string
    expect(approval.request).not.toHaveBeenCalled()
    expect(result).toContain('is proposed; cannot record "decided"')
  })

  it.each(['REJECT', 'KEEP_FOR_FURTHER_RESEARCH'] as const)(
    'evolution_decide settles an open proposal with %s through the native approval seam',
    async decision => {
      const svc = await service()
      await svc.propose(proposal, 'root-1')
      const { ctx, approval } = toolCtx(svc)
      const tool = defineEvolutionDecideTool(ctx)
      const missingReason = await tool.execute({ proposalId: 'p1', decision }, exec('root-1'))
      expect(missingReason).toContain('requires a reason in note')
      expect(approval.request).not.toHaveBeenCalled()
      const note = 'Current evidence supports keeping the existing method and exploring a different candidate.'
      const result = await tool.execute({ proposalId: 'p1', decision, note }, exec('root-1'))
      expect(approval.request).toHaveBeenCalledOnce()
      expect(approval.request.mock.calls[0]![0].reason).toContain(`proposed decision: ${decision} — ${note}`)
      expect(result).toContain(`[decided] ${decision}`)
      expect(await svc.get('p1')).toMatchObject({ status: 'decided', decision, decisionApprovalRef: 'approval:call-1' })
    },
  )

  it.each(['rejected', 'cancelled', 'unavailable'])(
    'keeps an open proposal unchanged when early settlement approval is %s',
    async outcome => {
      const svc = await service()
      await svc.propose(proposal, 'root-1')
      const { ctx, approval } = toolCtx(svc, outcome)
      const result = await defineEvolutionDecideTool(ctx).execute(
        { proposalId: 'p1', decision: 'REJECT', note: 'Candidate has no useful delta.' }, exec('root-1'),
      )
      expect(approval.request).toHaveBeenCalledOnce()
      expect(result).toContain('no decision recorded')
      expect((await svc.get('p1')).status).toBe('proposed')
      expect((await svc.get('p1')).history).toHaveLength(1)
    },
  )

  it('refuses a forged early decline without a reason when reopening the ledger', async () => {
    const svc = await service()
    await svc.propose(proposal, 'root-1')
    const forged = {
      formatVersion: 4, kind: 'decided', proposalId: 'p1', decision: 'REJECT',
      actor: 'root-1', at: 'now', approvalRef: 'approval:call-1',
    }
    await writeFile(join(svc.root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root: svc.root })
    await expect(reopened.list()).rejects.toThrow('requires a reason in note')
  })

  it('evolution_list filters and renders derived history', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc, 'rejected')
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    await defineEvolutionProposeTool(ctx).execute(
      {
        ...proposal,
        proposalId: 'p2',
        targetType: 'verifier',
        targetId: 'verifier:1',
        level: 'L4',
        sourceRefs: ['evidence:ev-1'],
      },
      exec('root-1'),
    )
    await defineEvolutionCandidateTool(ctx).execute(
      {
        proposalId: 's1',
        versionSet: VERSION_SET,
        mutationJson: JSON.stringify({ name: 'verify', content: skillText('x') }),
      },
      exec('root-1'),
    )
    const list = defineEvolutionListTool(ctx)
    const all = (await list.execute({}, exec('root-1'))) as string
    expect(all).toContain('evolution ledger (2):')
    expect(all).toContain('- p2 [proposed] L4 verifier verifier:1 (base v3)')
    expect(all).toContain('- s1 [candidate] L2 skill verify (base v1)')
    expect(all).toContain('history: proposed by root-1')
    const filtered = (await list.execute({ status: 'candidate' }, exec('root-1'))) as string
    expect(filtered).toContain('evolution ledger (1):')
    expect(filtered).toContain('s1')
    expect(filtered).not.toContain('p2')
    const byTarget = (await list.execute({ targetType: 'verifier' }, exec('root-1'))) as string
    expect(byTarget).toContain('evolution ledger (1):')
    expect(byTarget).toContain('p2')
  })
})

import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { EvolutionService } from '../../src/evolution.ts'
import { defineEvolutionApplyTool } from '../../../agent-singularity/src/tools/evolution-apply.ts'
import { defineEvolutionDecideTool } from '../../../agent-singularity/src/tools/evolution-decide.ts'
import { defineEvolutionListTool } from '../../../agent-singularity/src/tools/evolution-list.ts'
import { defineEvolutionRollbackTool } from '../../../agent-singularity/src/tools/evolution-rollback.ts'
import { compareReplaySides } from '../../src/replay.ts'
import {
  skillText,
  serviceWithProduction,
  toolCtx,
  skillProposal,
  PRODUCTION_V1,
  VERSION_SET,
  recordSkillExperiment,
  gateAnswers,
  exec,
  reopenLike,
  FIXTURE_SELECTION,
  walkToDecided,
  experimentReportPathOf,
  productionSkill,
  PRODUCTION_OLD,
  fixtureCtx,
  capabilityProposal,
  capabilityMutation,
  proposal,
} from './evolution.fixture.ts'

/** The production roots one fixture service writes to. */
type ProductionRoots = { root: string; skillRoot: string }

const PRODUCTION_CHAMPION = skillText('champion')

describe('replay evidence integrity and promotion', () => {
  it('holds changed commands and omitted failed criteria inconclusive', () => {
    const champion = {
      taskId: 'before',
      outcome: 'failed' as const,
      criteria: [{ criterionId: 'a', verdict: 'fail' as const, command: 'test' }],
    }
    expect(compareReplaySides(champion, { ...champion, criteria: [] }).relation).toBe('inconclusive')
    expect(
      compareReplaySides(champion, { ...champion, criteria: [{ ...champion.criteria[0]!, command: 'true' }] }).relation,
    ).toBe('inconclusive')
  })

  it('blocks a regressing holdout before human approval while allowing rejection', async () => {
    const { svc } = await serviceWithProduction()
    const { ctx, approval } = toolCtx(svc)
    // A skill candidate whose holdout degraded: the experiment is complete and
    // gated, and the promotion is what refuses.
    const id = skillProposal.proposalId
    await mkdir(join(svc.skillRoot, 'verify'), { recursive: true })
    await writeFile(join(svc.skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate(id, VERSION_SET, 'root-1', { name: 'verify', content: skillText('new') })
    await svc.prepare(id, 'root-1')
    const { reportPath } = await recordSkillExperiment(svc, id, { holdout: { candidate: 'failed' } })
    await svc.gate(id, gateAnswers([reportPath]), 'root-1')
    expect(
      await defineEvolutionDecideTool(ctx).execute({ proposalId: id, decision: 'PROMOTE' }, exec('root-1')),
    ).toContain('rejected:')
    expect(approval.request).not.toHaveBeenCalled()
    expect((await svc.get(id)).status).toBe('gated')
    await svc.decide(id, 'REJECT', 'root-1', 'approval:reject')
    expect((await svc.get(id)).decision).toBe('REJECT')
  })

  it.each(['decide', 'apply'])(
    'refuses a tampered experiment report at %s, including after service reopen',
    async stage => {
      const { svc, root, skillRoot } = await serviceWithProduction()
      await mkdir(join(skillRoot, 'verify'), { recursive: true })
      await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_CHAMPION)
      await svc.propose(skillProposal, 'root-1')
      await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('candidate') })
      await svc.prepare('s1', 'root-1')
      const { reportPath } = await recordSkillExperiment(svc, 's1')
      await svc.gate('s1', gateAnswers([reportPath]), 'root-1')
      if (stage === 'apply') await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:decide')
      await appendFile(join(root, reportPath), '\n')
      const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
      const action =
        stage === 'decide'
          ? reopened.decide('s1', 'PROMOTE', 'root-1', 'approval:decide')
          : reopened.apply('s1', 'root-1', 'approval:apply')
      await expect(action).rejects.toThrow('is not the report its ledger records recompute to')
      expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_CHAMPION)
    },
  )
})

describe('EvolutionService apply/rollback state machine', () => {
  it('walks decided(PROMOTE) → applied → rolledback and derives the full history', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })
    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(applied.proposal.status).toBe('applied')
    expect(applied.proposal.applied).toEqual({
      targets: [join(skillRoot, 'verify', 'SKILL.md')],
      approvalRef: 'approval:call-1',
    })
    const rolledback = await svc.rollback('s1', 'root-1', 'approval:call-2')
    expect(rolledback.proposal.status).toBe('rolledback')
    // A skill candidate's evaluation is the experiment, not a `replayed` line.
    expect(rolledback.proposal.history.map(entry => entry.status)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'gated',
      'decided',
      'applied',
      'rolledback',
    ])
  })

  it.each(['REJECT', 'KEEP_FOR_FURTHER_RESEARCH'] as const)(
    'refuses apply on a decided %s proposal',
    async decision => {
      const { svc, skillRoot } = await serviceWithProduction()
      await mkdir(join(skillRoot, 'verify'), { recursive: true })
      await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
      await svc.propose(skillProposal, 'root-1')
      await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# new') })
      await svc.prepare('s1', 'root-1')
      await recordSkillExperiment(svc, 's1')
      await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
      await svc.decide('s1', decision, 'root-1', 'approval:call-1')
      await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow(
        `cannot record "applied" — the recorded decision is ${decision}; only a PROMOTE decision can be applied`,
      )
      expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
    },
  )

  it('refuses apply before the decision, a repeated apply, rollback before apply, and a repeated rollback', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# new') })
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    await svc.prepare('s1', 'root-1')
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await expect(svc.rollback('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "rolledback"')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-1')
    await svc.apply('s1', 'root-1', 'approval:call-1')
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('is applied; cannot record "applied"')
    await svc.rollback('s1', 'root-1', 'approval:call-2')
    await expect(svc.rollback('s1', 'root-1', 'approval:call-3')).rejects.toThrow(
      'is rolledback; cannot record "rolledback"',
    )
  })

  it('refuses apply for an L4 skill candidate, pointing at the manual path', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await walkToDecided(
      svc,
      { ...skillProposal, proposalId: 's-l4', level: 'L4' },
      { name: 'verify', content: skillText('# new') },
    )
    await expect(svc.apply('s-l4', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
  })

  it('replays a ledger with applied and rolledback records to the same fold after reopen', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })
    await svc.apply('s1', 'root-1', 'approval:call-1')
    await svc.rollback('s1', 'root-1', 'approval:call-2')
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    const folded = await reopened.get('s1')
    expect(folded.status).toBe('rolledback')
    expect(folded.applied?.approvalRef).toBe('approval:call-1')
    expect(folded.rolledback?.approvalRef).toBe('approval:call-2')
    // proposed, candidate, prepared, gated, decided, applied, rolledback — a
    // skill candidate's evaluation is the experiment, not a lifecycle line.
    expect(folded.history).toHaveLength(7)
  })

  it('writes one v4 ledger through the whole walk, with no older vocabulary in any line', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot)
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })
    await svc.apply('s1', 'root-1', 'approval:call-1')
    await svc.rollback('s1', 'root-1', 'approval:call-2')

    const raw = (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    const records = raw.map(line => JSON.parse(line) as { formatVersion: number; kind: string })
    // Every line this build writes declares the ledger's own format version.
    expect(records.map(record => record.formatVersion)).toEqual(records.map(() => 4))
    // The lifecycle plus the experiment family — and no `replayed` record.
    expect(records.map(record => record.kind)).toEqual(
      expect.arrayContaining([
        'proposed',
        'candidate',
        'prepared',
        'experiment_started',
        'experiment_sample',
        'gated',
        'decided',
        'commit_intent',
        'applied',
        'commit_intent',
        'rolledback',
      ]),
    )
    expect(records.map(record => record.kind)).not.toContain('replayed')
    expect(raw.join('\n')).not.toContain('"replayed"')

    // The reopen folds the v4 ledger to the same state the live service holds.
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    expect(await reopened.list()).toEqual(await svc.list())
    expect((await reopened.get('s1')).history.map(entry => entry.status)).toEqual([
      'proposed',
      'candidate',
      'prepared',
      'gated',
      'decided',
      'applied',
      'rolledback',
    ])
    expect(await reopened.experiments('s1')).toHaveLength(1)
  })

  it('fails loudly on a forged applied record: wrong base state or a malformed payload', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await productionSkill(skillRoot, PRODUCTION_OLD)
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# new') })
    await svc.prepare('s1', 'root-1')
    await recordSkillExperiment(svc, 's1')
    await svc.gate('s1', gateAnswers([await experimentReportPathOf(svc)]), 'root-1')
    await svc.decide('s1', 'REJECT', 'root-1', 'approval:call-1')
    const forged = {
      formatVersion: 4,
      kind: 'applied',
      proposalId: 's1',
      targets: ['/x'],
      approvalRef: 'approval:call-9',
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root, skillRoot })
    await expect(reopened.list()).rejects.toThrow('cannot record "applied"')

    const root2 = await mkdtemp(join(tmpdir(), 'evolution-'))
    const skillRoot2 = join(root2, 'skills')
    await productionSkill(skillRoot2, PRODUCTION_OLD)
    const svc2 = new EvolutionService(fixtureCtx(), {
      modelSelection: () => FIXTURE_SELECTION,
      root: join(root2, 'evolution'),
      skillRoot: skillRoot2,
    })
    await svc2.propose(skillProposal, 'root-1')
    await svc2.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: skillText('# new') })
    await svc2.prepare('s1', 'root-1')
    const { reportPath: svc2Report } = await recordSkillExperiment(svc2, 's1')
    await svc2.gate('s1', gateAnswers([svc2Report]), 'root-1')
    await svc2.decide('s1', 'PROMOTE', 'root-1', 'approval:call-1')
    const malformed = {
      formatVersion: 4,
      kind: 'applied',
      proposalId: 's1',
      targets: [],
      approvalRef: '',
      actor: 'x',
      at: 'now',
    }
    await writeFile(join(svc2.root, 'proposals.jsonl'), `${JSON.stringify(malformed)}\n`, { flag: 'a' })
    const reopened2 = reopenLike(svc2, {
      modelSelection: () => FIXTURE_SELECTION,
      root: svc2.root,
      skillRoot: skillRoot2,
    })
    await expect(reopened2.list()).rejects.toThrow('malformed target list')
  })
})

describe('EvolutionService apply/rollback production writes', () => {
  it('applies a skill mutation over the production SKILL.md and rolls it back to the champion bytes', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })

    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(skillText('# new verify skill'))
    // The guidance object is one file, and the commit replaces exactly it. A
    // directory holding a file the object does not cover no longer reaches
    // apply: prepare refuses it by name (K3), so there is no auxiliary file for
    // a write to leave beside the replaced one.
    expect(applied.targets).toEqual([join(skillRoot, 'verify', 'SKILL.md')])

    await svc.rollback('s1', 'root-1', 'approval:call-2')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
  })

  it('refuses a hand-written lifecycle of another target type at its first line', async () => {
    const { svc, root } = await serviceWithProduction()
    // The fold admits exactly what the current entries write: a skill candidate
    // or a capability candidate, each in the shape its own lifecycle records. A
    // hand-written capability lifecycle of the shape a ledger written before
    // this build holds — the old `{ name, entry }` mutation and the bookkeeping
    // prepare that shape carried — is refused at load, at the candidate line,
    // before anything is read from it: no live entry can produce it, since this
    // build's `candidate` admits the one-whole-row shape only.
    await svc.propose(capabilityProposal, 'root-1')
    await appendFile(
      join(root, 'proposals.jsonl'),
      [
        {
          formatVersion: 4,
          kind: 'candidate',
          proposalId: 'c1',
          versionSet: { capabilityTable: 'config.yml#doc1' },
          mutation: capabilityMutation,
          actor: 'root-1',
          at: '2026-09-20T00:00:01.000Z',
        },
        {
          formatVersion: 4,
          kind: 'prepared',
          proposalId: 'c1',
          sandbox: null,
          mechanical: false,
          champion: 'none',
          files: [],
          actor: 'root-1',
          at: '2026-09-20T00:00:02.000Z',
        },
        {
          formatVersion: 4,
          kind: 'gated',
          proposalId: 'c1',
          gate: gateAnswers(['sandbox/c1/replay-report.json']),
          actor: 'root-1',
          at: '2026-09-20T00:00:04.000Z',
        },
        {
          formatVersion: 4,
          kind: 'decided',
          proposalId: 'c1',
          decision: 'PROMOTE',
          approvalRef: 'approval:legacy-decide',
          actor: 'root-1',
          at: '2026-09-20T00:00:05.000Z',
        },
        {
          formatVersion: 4,
          kind: 'applied',
          proposalId: 'c1',
          targets: ['legacy apply'],
          approvalRef: 'approval:legacy-apply',
          actor: 'root-1',
          at: '2026-09-20T00:00:06.000Z',
        },
      ]
        .map(line => JSON.stringify(line))
        .join('\n') + '\n',
    )
    const verbatim = await readFile(join(root, 'proposals.jsonl'), 'utf8')
    const reopened = reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, root })
    await expect(reopened.list()).rejects.toThrow('capability-row-invalid')
    await expect(reopened.get('c1')).rejects.toThrow('capability-row-invalid')
    // Nothing was read out of it and nothing was written beside it: the refused
    // file keeps its bytes, and the state machine is never reached.
    await expect(reopened.rollback('c1', 'root-1', 'approval:call-2')).rejects.toThrow('capability-row-invalid')
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(verbatim)
  })
})

describe('evolution_apply / evolution_rollback tools', () => {
  /** toolCtx on top of a production-fixture service (capability champion resolves from the taskRuntime mock). */
  /**
   * Hand-write the legacy decided(PROMOTE) lifecycle of a non-skill proposal —
   * a candidate, its bookkeeping prepare, its gate and the decision, all v2
   * records — into the ledger. This build's fold refuses that shape at its
   * candidate line, so what the returned service proves is the entry refusal:
   * no live entry writes a lifecycle of another target type.
   */
  async function legacyDecidedLedger(
    svc: EvolutionService,
    proposalId: string,
    roots: ProductionRoots,
  ): Promise<EvolutionService> {
    await appendFile(
      join(svc.root, 'proposals.jsonl'),
      [
        {
          formatVersion: 4,
          kind: 'candidate',
          proposalId,
          versionSet: { x: 'v1' },
          mutation: { baseVersion: 'v3', definition: { objective: 'the legacy definition' } },
          actor: 'root-1',
          at: '2026-09-20T00:00:01.000Z',
        },
        {
          formatVersion: 4,
          kind: 'prepared',
          proposalId,
          sandbox: null,
          mechanical: false,
          champion: 'none',
          files: [],
          actor: 'root-1',
          at: '2026-09-20T00:00:02.000Z',
        },
        {
          formatVersion: 4,
          kind: 'gated',
          proposalId,
          gate: gateAnswers([`sandbox/${proposalId}/replay-report.json`]),
          actor: 'root-1',
          at: '2026-09-20T00:00:04.000Z',
        },
        {
          formatVersion: 4,
          kind: 'decided',
          proposalId,
          decision: 'PROMOTE',
          approvalRef: 'approval:legacy-decide',
          actor: 'root-1',
          at: '2026-09-20T00:00:05.000Z',
        },
      ]
        .map(line => JSON.stringify(line))
        .join('\n') + '\n',
    )
    return reopenLike(svc, { modelSelection: () => FIXTURE_SELECTION, ...roots })
  }

  async function toolCtxWithProduction(approvalOutcome: string = 'allowed-once') {
    const production = await serviceWithProduction()
    const { ctx, approval } = toolCtx(production.svc, approvalOutcome)
    return { ...production, ctx, approval }
  }

  it('applies and rolls back a skill through both human approvals, with the targets named in the reason and the record', async () => {
    const { svc, ctx, approval, skillRoot } = await toolCtxWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })

    const applyTool = defineEvolutionApplyTool(ctx)
    const applied = (await applyTool.execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(applied).toContain('proposal s1 [applied] L2 skill verify — PROMOTE in effect')
    expect(applied).toContain(`  - ${join(skillRoot, 'verify', 'SKILL.md')}`)
    expect(applied).toContain('effective immediately — the skill filesystem watches the skill root')
    expect(applied).toContain('human approval: approval:call-1 — rollback with evolution_rollback')
    expect(approval.request).toHaveBeenCalledOnce()
    const request = approval.request.mock.calls[0]![0] as { reason: string; toolName: string }
    expect(request.toolName).toBe('evolution_apply')
    expect(request.reason).toContain('Evolution apply for proposal s1 (L2 skill verify, base v1)')
    expect(request.reason).toContain('recorded decision: PROMOTE')
    expect(request.reason).toContain(`  - ${join(skillRoot, 'verify', 'SKILL.md')}`)
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(skillText('# new verify skill'))

    const ledger = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    const appliedRecord = JSON.parse(ledger.at(-1)!) as { kind: string; targets: string[]; approvalRef: string }
    expect(appliedRecord.kind).toBe('applied')
    expect(appliedRecord.targets).toEqual([join(skillRoot, 'verify', 'SKILL.md')])
    expect(appliedRecord.approvalRef).toBe('approval:call-1')

    const rollbackTool = defineEvolutionRollbackTool(ctx)
    const rolledback = (await rollbackTool.execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(rolledback).toContain('proposal s1 [rolledback] L2 skill verify — champion restored')
    expect(approval.request).toHaveBeenCalledTimes(2)
    const rollbackRequest = approval.request.mock.calls[1]![0] as { reason: string; toolName: string }
    expect(rollbackRequest.toolName).toBe('evolution_rollback')
    expect(rollbackRequest.reason).toContain('this restores the champion snapshot')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
    expect((await svc.get('s1')).status).toBe('rolledback')
  })

  it.each(['rejected', 'cancelled', 'unavailable'])(
    'evolution_apply writes nothing when the approval comes back %s',
    async outcome => {
      const { svc, ctx, skillRoot } = await toolCtxWithProduction(outcome)
      await mkdir(join(skillRoot, 'verify'), { recursive: true })
      await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
      await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })
      const result = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
      expect(result).toContain('nothing written')
      expect(result).toContain('stays decided')
      expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_V1)
      expect((await svc.get('s1')).status).toBe('decided')
      const ledger = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      expect(ledger.map(line => (JSON.parse(line) as { kind: string }).kind)).not.toContain('applied')
    },
  )

  it('evolution_rollback writes nothing when the human rejects it', async () => {
    const { svc, ctx, approval, skillRoot } = await toolCtxWithProduction('allowed-once')
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_V1)
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new verify skill') })
    await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    approval.request.mockResolvedValue('rejected')
    const result = (await defineEvolutionRollbackTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(result).toContain('nothing written')
    expect(result).toContain('stays applied')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(skillText('# new verify skill'))
    expect((await svc.get('s1')).status).toBe('applied')
  })

  it('refuses without asking the human: non-decided and L4', async () => {
    const { svc, ctx, approval, skillRoot } = await toolCtxWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
    const applyTool = defineEvolutionApplyTool(ctx)

    await svc.propose(skillProposal, 'root-1')
    expect((await applyTool.execute({ proposalId: 's1' }, exec('root-1'))) as string).toContain(
      'proposal s1 is proposed; only a decided proposal can be applied',
    )

    await walkToDecided(
      svc,
      { ...skillProposal, proposalId: 's-l4', level: 'L4' },
      { name: 'verify', content: skillText('# new') },
    )
    expect((await applyTool.execute({ proposalId: 's-l4' }, exec('root-1'))) as string).toContain(
      'L4 harness evolution has no executor',
    )

    expect(approval.request).not.toHaveBeenCalled()
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_OLD)
  })

  it('refuses a legacy decided record of another target type at the entry, before the human is asked', async () => {
    const { svc, ctx, approval, skillRoot } = await toolCtxWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
    const applyTool = defineEvolutionApplyTool(ctx)

    await svc.propose(skillProposal, 'root-1')
    expect((await applyTool.execute({ proposalId: 's1' }, exec('root-1'))) as string).toContain(
      'proposal s1 is proposed; only a decided proposal can be applied',
    )

    await walkToDecided(
      svc,
      { ...skillProposal, proposalId: 's-l4', level: 'L4' },
      { name: 'verify', content: skillText('# new') },
    )
    expect((await applyTool.execute({ proposalId: 's-l4' }, exec('root-1'))) as string).toContain(
      'L4 harness evolution has no executor',
    )

    // A task_definition PROMOTE can no longer be *recorded* — `candidate`
    // refuses the target type by name and the fold refuses the same hand-written
    // shape at its first line — so the only thing an older ledger's decided
    // record reaches is that entry refusal: no human is asked and nothing is
    // written.
    const roots: ProductionRoots = { root: svc.root, skillRoot }
    await svc.propose(proposal, 'root-1')
    const legacyLedger = await legacyDecidedLedger(svc, 'p1', roots)
    await expect(legacyLedger.list()).rejects.toThrow('targets "task_definition"')
    const viaTool = (await defineEvolutionApplyTool({ ...(ctx as object), evolution: legacyLedger } as never).execute(
      { proposalId: 'p1' },
      exec('root-1'),
    )) as string
    expect(viaTool).toContain('evolution_apply rejected:')
    expect(viaTool).toContain('targets "task_definition"')

    expect(approval.request).not.toHaveBeenCalled()
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(PRODUCTION_OLD)
  })

  it('evolution_rollback refuses a proposal that is not applied, without asking the human', async () => {
    const { svc, ctx, approval } = await toolCtxWithProduction()
    await svc.propose(skillProposal, 'root-1')
    const result = (await defineEvolutionRollbackTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(approval.request).not.toHaveBeenCalled()
    expect(result).toContain('is proposed; only an applied proposal can be rolled back')
  })

  it('evolution_list renders applied and rolledback with their targets and approval refs', async () => {
    const { svc, ctx, skillRoot } = await toolCtxWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), PRODUCTION_OLD)
    await walkToDecided(svc, skillProposal, { name: 'verify', content: skillText('# new') })
    await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    await defineEvolutionRollbackTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    const listed = (await defineEvolutionListTool(ctx).execute({ status: 'rolledback' }, exec('root-1'))) as string
    expect(listed).toContain('- s1 [rolledback PROMOTE] L2 skill verify (base v1)')
    expect(listed).toContain(`applied: [${join(skillRoot, 'verify', 'SKILL.md')}] (approval approval:call-1)`)
    expect(listed).toContain('rolled back:')
    expect(listed).toContain('history: proposed by root-1')
  })
})

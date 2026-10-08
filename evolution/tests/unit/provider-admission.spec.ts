import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EvolutionService } from '../../src/evolution.ts'
import { defineEvolutionApplyTool } from '../../../agent-singularity/src/tools/evolution-apply.ts'
import { defineEvolutionDecideTool } from '../../../agent-singularity/src/tools/evolution-decide.ts'
import {
  capabilityProposal,
  capabilityMutation,
  gateAnswers,
  serviceWithProduction,
  reopenLike,
  FIXTURE_SELECTION,
  toolCtx,
  exec,
  type SkillShape,
  writeSkillDirectory,
  PROMOTION_ROW,
  skillText,
  skillCandidateGated,
  sha256Of,
  ledgerKinds,
  skillCandidateDirectory,
  P3_BASELINE,
  FIXTURE_CAPABILITIES,
} from './evolution.fixture.ts'

/**
 * Append the hand-written gated capability lifecycle — a candidate carrying the
 * capability mutation with the bookkeeping prepare of its shape, then its gate
 * — to the fixture's ledger. That shape is what a ledger written before this
 * build holds; this build's fold refuses it at the candidate line, so these
 * cases pin the entry refusal: the state is not reachable through the live
 * entries, and a hand-written file cannot smuggle it in either.
 */
async function capabilityGatedLedger(svc: EvolutionService, proposalId: string): Promise<void> {
  await svc.propose({ ...capabilityProposal, proposalId }, 'root-1')
  await appendFile(
    join(svc.root, 'proposals.jsonl'),
    [
      {
        formatVersion: 4,
        kind: 'candidate',
        proposalId,
        versionSet: { capabilityTable: 'config.yml#doc1' },
        mutation: capabilityMutation,
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
    ]
      .map(line => JSON.stringify(line))
      .join('\n') + '\n',
  )
}

/**
 * The capability lifecycle a ledger written before this build holds — the old
 * `{ name, entry }` mutation with the bookkeeping prepare that shape carried —
 * is refused at the fold, at its candidate line: this build's capability
 * candidate is one whole row plus an optional new execution skill
 * (`capability-candidate.spec.ts`), so the old shape is a mutation no live entry
 * writes and no fold admits. The refusal reaches the tools the same way, and
 * nothing is read out of the file to decide it.
 */
describe('a capability lifecycle written in the old shape is refused at the fold', () => {
  it('refuses a hand-written gated capability lifecycle at the entry, writing nothing', async () => {
    const { svc, configFile } = await serviceWithProduction()
    const before = await readFile(configFile, 'utf8')
    await capabilityGatedLedger(svc, 'c2')
    const forged = reopenLike(svc, {
      modelSelection: () => FIXTURE_SELECTION,
      root: svc.root,
      skillRoot: svc.skillRoot,
    })

    // The fold admits what the live entries write: a capability lifecycle in a
    // shape no live entry produces cannot be folded from a file either, so no
    // `gated` capability proposal exists to decide.
    await expect(forged.list()).rejects.toThrow('capability-row-invalid')
    await expect(forged.get('c2')).rejects.toThrow('capability-row-invalid')
    await expect(forged.decide('c2', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow('capability-row-invalid')

    // Through the tools the same refusal reaches the caller, still without a
    // human being asked for a proposal that cannot be promoted.
    const { ctx, approval } = toolCtx(forged)
    const viaDecideTool = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 'c2', decision: 'PROMOTE' },
      exec('root-1'),
    )) as string
    expect(viaDecideTool).toContain('evolution_decide rejected:')
    expect(viaDecideTool).toContain('capability-row-invalid')
    const viaApplyTool = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 'c2' }, exec('root-1'))) as string
    expect(viaApplyTool).toContain('evolution_apply rejected:')
    expect(viaApplyTool).toContain('capability-row-invalid')
    expect(approval.request).not.toHaveBeenCalled()

    // Nothing was read out of the refused file and config.yml is byte-identical
    // to what it was.
    expect(await readFile(configFile, 'utf8')).toBe(before)
    const kinds = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => (JSON.parse(line) as { kind: string }).kind)
    expect(kinds).not.toContain('decided')
    expect(kinds).not.toContain('applied')
  })

  it('refuses an applied capability record at the entry, before an apply can read it', async () => {
    const { svc, configFile } = await serviceWithProduction()
    await capabilityGatedLedger(svc, 'c2')
    // The decided and applied lines an older ledger holds sit on top of the same
    // lifecycle; the refusal lands at the candidate line, so no apply entry ever
    // reads the decision or the applied record.
    await appendFile(
      join(svc.root, 'proposals.jsonl'),
      [
        {
          formatVersion: 4,
          kind: 'decided',
          proposalId: 'c2',
          decision: 'PROMOTE',
          approvalRef: 'approval:legacy',
          actor: 'root-1',
          at: '2026-09-20T00:00:05.000Z',
        },
        {
          formatVersion: 4,
          kind: 'applied',
          proposalId: 'c2',
          targets: [`${configFile} — document 1 task-runtime capabilities row "research"`],
          approvalRef: 'approval:apply',
          actor: 'root-1',
          at: '2026-09-20T00:00:06.000Z',
        },
      ]
        .map(line => JSON.stringify(line))
        .join('\n') + '\n',
    )
    const before = await readFile(configFile, 'utf8')
    const reopened = reopenLike(svc, {
      modelSelection: () => FIXTURE_SELECTION,
      root: svc.root,
      skillRoot: svc.skillRoot,
    })

    await expect(reopened.list()).rejects.toThrow('capability-row-invalid')
    await expect(reopened.get('c2')).rejects.toThrow('capability-row-invalid')
    await expect(reopened.apply('c2', 'root-1', 'approval:call-1')).rejects.toThrow('capability-row-invalid')
    const { ctx, approval } = toolCtx(reopened)
    const viaApplyTool = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 'c2' }, exec('root-1'))) as string
    expect(viaApplyTool).toContain('evolution_apply rejected:')
    expect(viaApplyTool).toContain('capability-row-invalid')
    expect(approval.request).not.toHaveBeenCalled()
    expect(await readFile(configFile, 'utf8')).toBe(before)
  })
})

describe('skill candidate provider pre-check (S1-C item 3)', () => {
  /** The production execution object a two-file candidate is prepared against. */
  const executionProduction =
    (skillRoot: string, content: string, shape: SkillShape = {}) =>
    async (): Promise<void> => {
      await writeSkillDirectory(join(skillRoot, 'verify'), 'verify', content, {
        sidecar: 'execution',
        verifierRef: 'command',
        capabilities: [PROMOTION_ROW],
        requiredTools: ['bash'],
        ...shape,
      })
    }

  it('refuses an execution candidate whose verifier is unregistered, at decide, through the tool and at the service entry', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    const content = skillText('# candidate claiming execution')
    // The production object — and therefore the derived candidate — declares a
    // verifier this deployment never registered: the declaration is a valid
    // shape, and only the provider check can refuse it.
    const identity = await skillCandidateGated(
      svc,
      content,
      's1',
      executionProduction(skillRoot, skillText('# production with a ghost verifier'), {
        verifierRef: 'ghost-verifier',
      }),
    )
    expect(identity.contract).toBeDefined()

    await expect(svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow(/verifier-unknown/)
    expect((await svc.get('s1')).status).toBe('gated')
    // P2's identity check still passes — both candidate files are the ones
    // prepare froze — so it is the provider check that refuses, which is what
    // P2 could not see.
    const candidate = await svc.readSkillCandidate('s1')
    expect(candidate.skillMd).toEqual(Buffer.from(content, 'utf8'))
    expect(candidate.sidecar).toBeDefined()
    expect(identity.sha256).toBe(sha256Of(content))

    const { ctx, approval } = toolCtx(svc)
    const viaDecideTool = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 's1', decision: 'PROMOTE' },
      exec('root-1'),
    )) as string
    expect(viaDecideTool).toContain('evolution_decide rejected:')
    expect(viaDecideTool).toContain('verifier-unknown')
    expect(approval.request).not.toHaveBeenCalled()

    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('is gated')
    // Nothing written, nothing recorded: production still holds the baseline, and
    // no `applied` line was taken.
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it('refuses a candidate whose provider requires tools its declared capability does not grant', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    const content = skillText('# candidate needing a shell')
    await skillCandidateGated(
      svc,
      content,
      's1',
      executionProduction(skillRoot, skillText('# production needing a shell'), {
        // `research` is in the table and grants no tools at all.
        capabilities: ['research'],
      }),
    )

    await expect(svc.checkPromotion('s1')).rejects.toThrow(/tool-not-covered/)
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it.each([
    [
      'an execution sidecar',
      {
        sidecar: 'execution',
        verifierRef: 'command',
        capabilities: [PROMOTION_ROW],
        requiredTools: ['bash'],
      } as SkillShape,
    ],
    ['a knowledge sidecar', { sidecar: 'knowledge' } as SkillShape],
  ])('refuses a sidecar that appears beside a guidance candidate: %s', async (_label, shape) => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# a guidance candidate that gains a declaration')
    await skillCandidateGated(svc, content)
    // The object prepare froze is guidance — one file. A sidecar of any kind
    // appearing afterwards is a different object, and the shape is part of the
    // identity: production would receive a pair the experiment never evaluated.
    await writeSkillDirectory(skillCandidateDirectory(root), 'verify', content, shape)

    const refusal = await svc
      .checkPromotion('s1')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    expect(refusal).toContain('no longer matches its frozen content identity')

    // decide(PROMOTE), the tool before it asks a human, and the service entry
    // refuse alike: no decision recorded, no approval burned, no production write.
    await expect(svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')).rejects.toThrow(
      'no longer matches its frozen content identity',
    )
    expect((await svc.get('s1')).status).toBe('gated')
    const { ctx, approval } = toolCtx(svc)
    const viaDecideTool = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 's1', decision: 'PROMOTE' },
      exec('root-1'),
    )) as string
    expect(viaDecideTool).toContain('evolution_decide rejected:')
    expect(viaDecideTool).toContain('no longer matches its frozen content identity')
    expect(approval.request).not.toHaveBeenCalled()
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(svc.root)).not.toContain('decided')
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it('refuses a candidate carrying a resource this executor would never write', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# candidate with a reference file')
    await skillCandidateGated(svc, content)
    const directory = skillCandidateDirectory(root)
    await mkdir(join(directory, 'references'), { recursive: true })
    await writeFile(join(directory, 'references', 'notes.md'), 'a file this executor would never write\n')

    const refusal = await svc
      .checkPromotion('s1')
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
    // A resource the executor would never write makes the directory a different
    // object than the one prepare froze, so the whole-object identity refuses it.
    expect(refusal).toContain('no longer matches its frozen content identity')
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    expect((await svc.get('s1')).status).toBe('gated')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it('promotes a candidate with no sidecar as guidance, keeping the P2/P3 path intact', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    const content = skillText('# guidance candidate')
    await skillCandidateGated(svc, content)

    const check = await svc.checkPromotion('s1')
    expect(check.providers).toMatchObject([{ name: 'verify', role: 'guidance' }])
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(applied.providers).toMatchObject([{ name: 'verify', role: 'guidance' }])
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(content)
  })

  it('refuses a provider that cannot be judged because the verifier registry is unlistable (fail-closed)', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# execution candidate on a deployment with no verifier service')
    await skillCandidateGated(
      svc,
      content,
      's1',
      executionProduction(skillRoot, skillText('# production execution skill')),
    )

    // Same ledger, same sandbox, but a context with no verifier service: the ref
    // cannot be proven registered, so the candidate is refused rather than
    // assumed valid — the same refusal admission gives the same situation.
    const bare = new EvolutionService(
      {
        reflect: { provide: () => {} },
        effect: () => {},
        taskRuntime: { listCapabilities: () => structuredClone(FIXTURE_CAPABILITIES) },
      } as never,
      { root, skillRoot },
    )
    await expect(bare.checkPromotion('s1')).rejects.toThrow(/verifier registry cannot be listed/)
    expect(await ledgerKinds(root)).not.toContain('applied')
  })

  it('refuses the apply tool before asking the human when a sidecar appears after the decision', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# guidance candidate that gains a sidecar')
    await skillCandidateGated(svc, content)
    // The candidate is guidance when it is decided; nothing about its bytes
    // changes afterwards — only a declaration the reviewed version did not have.
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')
    await writeSkillDirectory(skillCandidateDirectory(root), 'verify', content, {
      sidecar: 'execution',
      verifierRef: 'ghost-verifier',
      capabilities: [PROMOTION_ROW],
      requiredTools: ['bash'],
    })

    const { ctx, approval } = toolCtx(svc)
    const refused = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(refused).toContain('evolution_apply rejected:')
    expect(refused).toContain('no longer matches its frozen content identity')
    expect(approval.request).not.toHaveBeenCalled()
    expect((await svc.get('s1')).status).toBe('decided')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })

  it('refuses at the service entry when the sidecar appears while the human is deciding', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    const content = skillText('# candidate that gains a sidecar while the human decides')
    await skillCandidateGated(svc, content)
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-0')

    const approval = {
      request: vi.fn(async () => {
        await writeSkillDirectory(skillCandidateDirectory(root), 'verify', content, {
          sidecar: 'execution',
          verifierRef: 'ghost-verifier',
          capabilities: [PROMOTION_ROW],
          requiredTools: ['bash'],
        })
        return 'allowed-once' as const
      }),
    }
    const base = toolCtx(svc)
    const ctx = { ...(base.ctx as unknown as Record<string, unknown>), approval } as never

    const result = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(approval.request).toHaveBeenCalledOnce()
    expect(result).toContain('evolution_apply rejected:')
    expect(result).toContain('no longer matches its frozen content identity')
    expect((await svc.get('s1')).status).toBe('decided')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe(P3_BASELINE)
    expect(await ledgerKinds(svc.root)).not.toContain('applied')
  })
})

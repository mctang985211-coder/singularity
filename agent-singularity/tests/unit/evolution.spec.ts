import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EvolutionService } from '../../src/evolution.ts'
import type { GateAnswers, ProposeInput } from '../../src/evolution.ts'
import { editCapabilityRow, readCapabilityRowSource, restoreCapabilityRowSource } from '../../src/config-edit.ts'
import { defineEvolutionApplyTool } from '../../src/tools/evolution-apply.ts'
import { defineEvolutionCandidateTool } from '../../src/tools/evolution-candidate.ts'
import { defineEvolutionDecideTool } from '../../src/tools/evolution-decide.ts'
import { defineEvolutionGateTool } from '../../src/tools/evolution-gate.ts'
import { defineEvolutionListTool } from '../../src/tools/evolution-list.ts'
import { defineEvolutionPrepareTool } from '../../src/tools/evolution-prepare.ts'
import { defineEvolutionProposeTool } from '../../src/tools/evolution-propose.ts'
import { defineEvolutionReplayTool } from '../../src/tools/evolution-replay.ts'
import { defineEvolutionRollbackTool } from '../../src/tools/evolution-rollback.ts'
import { compareReplaySides, overallReplayVerdict } from '../../src/replay.ts'

function fixtureCtx() {
  return { reflect: { provide: () => {} }, effect: () => {} } as never
}

async function service() {
  const root = await mkdtemp(join(tmpdir(), 'evolution-'))
  // A configFile path that is never written: a capability prepare reads it,
  // misses (ENOENT), and marks the champion code-default (W19).
  return new EvolutionService(fixtureCtx(), { root, configFile: join(root, 'config.yml') })
}

const proposal: ProposeInput = {
  proposalId: 'p1',
  targetType: 'task_definition',
  targetId: 'build:1',
  baseVersion: 'v3',
  level: 'L2',
  rationale: 'the acceptance command never feeds empty input',
  sourceRefs: ['diagnosis:d1'],
}

function gateAnswers(refs: string[]): GateAnswers {
  return {
    targetFailureFixed: 'empty-input fixture now passes',
    originalAcceptanceMaintained: 'original criteria unchanged and green',
    existingRegressionMaintained: 'full suite replayed green',
    noUnacceptableSideEffects: 'diff touches one command only',
    holdoutPerformanceAcceptable: 'held-out fixtures pass',
    resourceCostAcceptable: 'same runtime as baseline',
    regressionEvidenceRefs: refs,
  }
}

const VERSION_SET = { taskDefinition: 'v3', verifier: 'v1' }

/** A minimal executed replay report over one comparison, for service-level state-machine tests. */
function replayReport(proposalId: string, targetType: ProposeInput['targetType'], overrides: Record<string, unknown> = {}) {
  return {
    formatVersion: 1,
    proposalId,
    targetType,
    at: new Date().toISOString(),
    mode: 'executed',
    observed: [{
      taskId: 't-champion',
      candidateTaskId: 't-candidate',
      champion: { taskId: 't-champion', runId: 'r-champion', outcome: 'verified', criteria: [] },
      candidate: { taskId: 't-candidate', runId: 'r-candidate', outcome: 'verified', criteria: [] },
      verdictMatch: true,
      criteriaDiff: [],
      relation: 'not-worse',
    }],
    holdout: { executed: false, tasks: [] },
    verdict: 'not-worse',
    ...overrides,
  }
}

describe('EvolutionService ledger', () => {
  it('walks proposed → candidate → gated → decided and derives history from appended records', async () => {
    const svc = await service()
    await svc.propose(proposal, 'root-1')
    await svc.candidate('p1', VERSION_SET, 'root-1')
    const evidenceFile = join(svc.root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await svc.gate('p1', gateAnswers([evidenceFile]), 'root-1')
    const decided = await svc.decide('p1', 'PROMOTE', 'root-1', 'approval:call-1', 'approved by human')
    expect(decided.status).toBe('decided')
    expect(decided.decision).toBe('PROMOTE')
    expect(decided.decisionNote).toBe('approved by human')
    expect(decided.decisionApprovalRef).toBe('approval:call-1')
    expect(decided.history.map(entry => entry.status)).toEqual(['proposed', 'candidate', 'gated', 'decided'])
  })

  it('rejects state-machine skips: gate on proposed, decide on candidate, candidate twice', async () => {
    const svc = await service()
    await svc.propose(proposal, 'root-1')
    await expect(svc.gate('p1', gateAnswers(['/x']), 'root-1')).rejects.toThrow('cannot record "gated"')
    await expect(svc.decide('p1', 'REJECT', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "decided"')
    await svc.candidate('p1', VERSION_SET, 'root-1')
    await expect(svc.candidate('p1', VERSION_SET, 'root-1')).rejects.toThrow('cannot record "candidate"')
    await expect(svc.propose(proposal, 'root-1')).rejects.toThrow('already exists')
  })

  it('rejects moves on an unknown proposal id', async () => {
    const svc = await service()
    await expect(svc.candidate('ghost', VERSION_SET, 'root-1')).rejects.toThrow('unknown proposal "ghost"')
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
    await svc.propose(proposal, 'root-1')
    await expect(svc.candidate('p1', {}, 'root-1')).rejects.toThrow('at least one version')
    await expect(svc.candidate('p1', { verifier: ' ' }, 'root-1')).rejects.toThrow('versionSet["verifier"]')
    await expect(svc.candidate('p1', { verifier: 1 as never }, 'root-1')).rejects.toThrow('versionSet["verifier"]')
  })

  it('requires all six gate answers and existence-checked regression evidence refs', async () => {
    const svc = await service()
    await svc.propose(proposal, 'root-1')
    await svc.candidate('p1', VERSION_SET, 'root-1')
    await expect(svc.gate('p1', { ...gateAnswers(['/x']), targetFailureFixed: '' }, 'root-1')).rejects.toThrow('Target failure fixed')
    await expect(svc.gate('p1', gateAnswers([]), 'root-1')).rejects.toThrow('at least one evidence ref')
    await expect(svc.gate('p1', gateAnswers(['no/such/path.log']), 'root-1')).rejects.toThrow('no known evidence id and no existing path')
    // a resolver id (task-store evidence) also satisfies existence — checked, never executed
    await svc.gate('p1', gateAnswers(['evidence-r1-abc']), 'root-1', async ref => ref === 'evidence-r1-abc')
    expect((await svc.get('p1')).status).toBe('gated')
  })

  it('requires human-approval evidence on decide and records it on the ledger line', async () => {
    const svc = await service()
    await svc.propose(proposal, 'root-1')
    await svc.candidate('p1', VERSION_SET, 'root-1')
    const evidenceFile = join(svc.root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await svc.gate('p1', gateAnswers([evidenceFile]), 'root-1')
    await expect(svc.decide('p1', 'PROMOTE', 'root-1', '')).rejects.toThrow('approvalRef')
    expect((await svc.get('p1')).status).toBe('gated')
    await svc.decide('p1', 'PROMOTE', 'root-1', 'approval:call-1', 'approved by human')
    const lines = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: 'decided', approvalRef: 'approval:call-1' })
    expect((await svc.get('p1')).decisionApprovalRef).toBe('approval:call-1')
    // and the fold after reopen keeps the ref
    const reopened = new EvolutionService(fixtureCtx(), { root: svc.root })
    expect((await reopened.get('p1')).decisionApprovalRef).toBe('approval:call-1')
  })

  it('is append-only and immutable: duplicate ids rejected, replay after reopen matches the live fold', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const first = new EvolutionService(fixtureCtx(), { root })
    await first.propose(proposal, 'root-1')
    await first.propose({ ...proposal, proposalId: 'p2', targetType: 'verifier', level: 'L4' }, 'root-1')
    await first.candidate('p1', VERSION_SET, 'root-1')
    await expect(first.propose(proposal, 'root-1')).rejects.toThrow('already exists')
    const live = await first.list()
    // three lines on disk, one per record, never rewritten
    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines.map(line => (JSON.parse(line) as { kind: string }).kind)).toEqual(['proposed', 'proposed', 'candidate'])
    // close: drain writes, reopen a fresh service on the same root, replay must fold to the same state
    const reopened = new EvolutionService(fixtureCtx(), { root })
    expect(await reopened.list()).toEqual(live)
    expect((await reopened.get('p1')).status).toBe('candidate')
    expect((await reopened.get('p2')).level).toBe('L4')
  })

  it('fails loudly on a corrupt ledger line instead of silently drifting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { root })
    await svc.propose(proposal, 'root-1')
    await writeFile(join(root, 'proposals.jsonl'), 'not json\n', { flag: 'a' })
    const reopened = new EvolutionService(fixtureCtx(), { root })
    await expect(reopened.list()).rejects.toThrow('corrupt ledger line 2')
  })

  it('fails loudly when a replayed migration violates the state machine', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { root })
    await svc.propose(proposal, 'root-1')
    const forged = { formatVersion: 1, kind: 'decided', proposalId: 'p1', decision: 'PROMOTE', actor: 'x', at: 'now' }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    const reopened = new EvolutionService(fixtureCtx(), { root })
    await expect(reopened.list()).rejects.toThrow('cannot record "decided"')
  })
})

const graph = { id: 'graph1', name: 'graph1', envId: 'project1', rootSessionId: 'root-1' }

function toolCtx(svc: EvolutionService, approvalOutcome: string = 'allowed-once') {
  const approval = { request: vi.fn(async () => approvalOutcome) }
  const ctx = {
    reflect: { provide: () => {} },
    effect: () => {},
    evolution: svc,
    approval,
    graphs: { graphForSession: vi.fn(async () => graph) },
    taskRuntime: { listCapabilities: vi.fn(() => ({ research: { preset: 'standard' } })), applyCapabilityRow: vi.fn() },
    task: {
      openStore: vi.fn(async () => ({
        diagnoses: [
          {
            diagnosisId: 'd1',
            taskId: 't1',
            observedFailure: 'ac fails',
            scope: 'this task',
            localizedCause: 'empty input never fed',
            evidenceRefs: ['ev-1'],
            reviewRefs: ['t1#r1'],
            confidence: 'medium',
            proposals: [{ targetType: 'task_definition', targetId: 'build:1', rationale: 'add empty-input fixture' }],
          },
        ],
        evidence: [{ evidenceId: 'ev-1' }],
      })),
    },
  }
  return { ctx: ctx as never, approval }
}

function exec(sessionId: string) {
  return { agent: { id: sessionId }, callId: 'call-1', signal: new AbortController().signal } as never
}

describe('evolution tools', () => {
  it('evolution_propose registers manually and reports bookkeeping-only', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionProposeTool(ctx)
    const result = (await tool.execute({ ...proposal }, exec('root-1'))) as string
    expect(result).toContain('proposal p1 registered [proposed] L2 task_definition build:1 (base v3)')
    expect(result).toContain('nothing was executed or changed')
    expect((await svc.get('p1')).status).toBe('proposed')
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
        { proposalId: 'p2', level: 'L2', baseVersion: 'v3', targetId: 'x', fromDiagnosis: { diagnosisId: 'd1', proposalIndex: 0 } },
        exec('root-1'),
      ),
    ).rejects.toThrow('do not pass both')
    const missing = (await tool.execute(
      { proposalId: 'p2', level: 'L2', baseVersion: 'v3' },
      exec('root-1'),
    ).catch((error: Error) => String(error))) as string
    expect(missing).toContain('required without fromDiagnosis')
  })

  it('evolution_candidate and evolution_gate move the proposal and stay ledger-only', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...proposal }, exec('root-1'))
    const candidate = (await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 'p1', versionSet: VERSION_SET },
      exec('root-1'),
    )) as string
    expect(candidate).toContain('[candidate] version set: taskDefinition=v3, verifier=v1')
    const gated = (await defineEvolutionGateTool(ctx).execute(
      { proposalId: 'p1', ...gateAnswers(['ev-1']) },
      exec('root-1'),
    )) as string
    expect(gated).toContain('[gated] gate answered 6/6, regression evidence: [ev-1]')
    expect((await svc.get('p1')).status).toBe('gated')
  })

  it('evolution_gate rejects evidence refs unknown to the task store and the disk', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...proposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute({ proposalId: 'p1', versionSet: VERSION_SET }, exec('root-1'))
    const result = (await defineEvolutionGateTool(ctx).execute(
      { proposalId: 'p1', ...gateAnswers(['ev-ghost']) },
      exec('root-1'),
    )) as string
    expect(result).toContain('evolution_gate rejected:')
    expect(result).toContain('ev-ghost')
    expect((await svc.get('p1')).status).toBe('candidate')
  })

  it('evolution_decide records only after a human approve through the native approval seam', async () => {
    const svc = await service()
    const { ctx, approval } = toolCtx(svc, 'allowed-once')
    await defineEvolutionProposeTool(ctx).execute({ ...proposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute({ proposalId: 'p1', versionSet: VERSION_SET }, exec('root-1'))
    await defineEvolutionGateTool(ctx).execute({ proposalId: 'p1', ...gateAnswers(['ev-1']) }, exec('root-1'))
    const result = (await defineEvolutionDecideTool(ctx).execute(
      { proposalId: 'p1', decision: 'PROMOTE', note: 'looks right' },
      exec('root-1'),
    )) as string
    expect(approval.request).toHaveBeenCalledOnce()
    const request = approval.request.mock.calls[0]![0] as { reason: string; toolName: string }
    expect(request.toolName).toBe('evolution_decide')
    expect(request.reason).toContain('proposal p1')
    expect(request.reason).toContain('3. Existing regression maintained? full suite replayed green [evidence: ev-1]')
    expect(request.reason).toContain('proposed decision: PROMOTE — looks right')
    expect(result).toContain('proposal p1 [decided] PROMOTE — looks right')
    expect(result).toContain('nothing applied yet; evolution_apply (second human gate) takes it to production')
    expect((await svc.get('p1')).status).toBe('decided')
    // the decided ledger line carries the approval call id, the applied/rolledback shape
    const lines = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: 'decided', approvalRef: 'approval:call-1' })
  })

  it.each(['rejected', 'cancelled', 'unavailable'])(
    'evolution_decide records nothing when the approval comes back %s',
    async outcome => {
      const svc = await service()
      const { ctx, approval } = toolCtx(svc, outcome)
      await defineEvolutionProposeTool(ctx).execute({ ...proposal }, exec('root-1'))
      await defineEvolutionCandidateTool(ctx).execute({ proposalId: 'p1', versionSet: VERSION_SET }, exec('root-1'))
      await defineEvolutionGateTool(ctx).execute({ proposalId: 'p1', ...gateAnswers(['ev-1']) }, exec('root-1'))
      const result = (await defineEvolutionDecideTool(ctx).execute({ proposalId: 'p1', decision: 'REJECT' }, exec('root-1'))) as string
      expect(approval.request).toHaveBeenCalledOnce()
      expect(result).toContain('no decision recorded')
      expect(result).toContain('stays gated')
      expect((await svc.get('p1')).status).toBe('gated')
      const lines = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      expect(lines.map(line => (JSON.parse(line) as { kind: string }).kind)).toEqual(['proposed', 'candidate', 'gated'])
    },
  )

  it('evolution_decide refuses a proposal that is not gated, without asking the human', async () => {
    const svc = await service()
    const { ctx, approval } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...proposal }, exec('root-1'))
    const result = (await defineEvolutionDecideTool(ctx).execute({ proposalId: 'p1', decision: 'REJECT' }, exec('root-1'))) as string
    expect(approval.request).not.toHaveBeenCalled()
    expect(result).toContain('is proposed; only a gated proposal can be decided')
  })

  it('evolution_list filters and renders derived history', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc, 'rejected')
    await defineEvolutionProposeTool(ctx).execute({ ...proposal }, exec('root-1'))
    await defineEvolutionProposeTool(ctx).execute(
      { ...proposal, proposalId: 'p2', targetType: 'verifier', targetId: 'verifier:1', level: 'L4', sourceRefs: ['evidence:ev-1'] },
      exec('root-1'),
    )
    await defineEvolutionCandidateTool(ctx).execute({ proposalId: 'p1', versionSet: VERSION_SET }, exec('root-1'))
    const list = defineEvolutionListTool(ctx)
    const all = (await list.execute({})) as string
    expect(all).toContain('evolution ledger (2):')
    expect(all).toContain('- p2 [proposed] L4 verifier verifier:1 (base v3)')
    expect(all).toContain('- p1 [candidate] L2 task_definition build:1 (base v3)')
    expect(all).toContain('history: proposed by root-1')
    const filtered = (await list.execute({ status: 'candidate' })) as string
    expect(filtered).toContain('evolution ledger (1):')
    expect(filtered).toContain('p1')
    expect(filtered).not.toContain('p2')
    const byTarget = (await list.execute({ targetType: 'verifier' })) as string
    expect(byTarget).toContain('evolution ledger (1):')
    expect(byTarget).toContain('p2')
  })
})


const skillProposal: ProposeInput = {
  proposalId: 's1',
  targetType: 'skill',
  targetId: 'verify',
  baseVersion: 'v1',
  level: 'L2',
  rationale: 'the skill never mentions empty-input fixtures',
  sourceRefs: ['diagnosis:d1'],
}

const presetProposal: ProposeInput = {
  proposalId: 'pr1',
  targetType: 'agent_preset',
  targetId: 'bb-verify',
  baseVersion: 'v1',
  level: 'L3',
  rationale: 'the preset lacks the check skill',
  sourceRefs: ['diagnosis:d1'],
}

const capabilityProposal: ProposeInput = {
  proposalId: 'c1',
  targetType: 'capability',
  targetId: 'research',
  baseVersion: 'v1',
  level: 'L2',
  rationale: 'research needs the verify skill',
  sourceRefs: ['diagnosis:d1'],
}

const capabilityMutation = { name: 'research', entry: { preset: 'standard', skills: ['verify'] } }

/** Service whose ledger root and production roots all live in one fresh temp dir (config.yml never written → capability champions read as code-default). */
async function serviceWithRoots() {
  const dir = await mkdtemp(join(tmpdir(), 'evolution-'))
  const root = join(dir, 'evolution')
  const skillRoot = join(dir, 'skills')
  const presetRoot = join(dir, '.agent-presets')
  const svc = new EvolutionService(fixtureCtx(), { root, skillRoot, presetRoot, configFile: join(dir, 'config.yml') })
  return { svc, dir, root, skillRoot, presetRoot }
}

describe('EvolutionService mutation schemas', () => {
  it('accepts the four mechanical mutations, shaped per targetType', async () => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    await svc.propose(presetProposal, 'root-1')
    await svc.propose(capabilityProposal, 'root-1')
    await svc.propose(proposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: 'new SKILL.md text' })
    await svc.candidate('pr1', VERSION_SET, 'root-1', { presetId: 'bb-verify', files: [{ path: 'preset.yml', content: 'x' }] })
    await svc.candidate('c1', VERSION_SET, 'root-1', capabilityMutation)
    await svc.candidate('p1', VERSION_SET, 'root-1', { baseVersion: 'v3', definition: { objective: 'new' } })
    expect((await svc.get('s1')).mutation).toEqual({ name: 'verify', content: 'new SKILL.md text' })
    expect((await svc.get('p1')).mutation).toEqual({ baseVersion: 'v3', definition: { objective: 'new' } })
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

  it.each([
    ['a traversing presetId', { presetId: '../x', files: [{ path: 'a', content: 'x' }] }, 'mutation.presetId'],
    ['no files', { presetId: 'bb-verify', files: [] }, 'non-empty array'],
    ['a file without content', { presetId: 'bb-verify', files: [{ path: 'a' }] }, 'mutation.files[0].content'],
    ['a file with an unknown key', { presetId: 'bb-verify', files: [{ path: 'a', content: 'x', mode: 'w' }] }, 'unknown key "mode"'],
  ])('rejects an agent_preset mutation with %s', async (_label, mutation, message) => {
    const svc = await service()
    await svc.propose(presetProposal, 'root-1')
    await expect(svc.candidate('pr1', VERSION_SET, 'root-1', mutation)).rejects.toThrow(message as string)
  })

  it.each(['../escape', 'a/../../b', '/abs/path', 'C:\\win\\abs', 'a//b', './dot', 'trailing/'])(
    'rejects the preset file path "%s" (relative, no traversal, no absolute)',
    async path => {
      const svc = await service()
      await svc.propose(presetProposal, 'root-1')
      await expect(
        svc.candidate('pr1', VERSION_SET, 'root-1', { presetId: 'bb-verify', files: [{ path, content: 'x' }] }),
      ).rejects.toThrow('mutation.files[0].path')
    },
  )

  it.each([
    ['an empty entry', { name: 'research', entry: {} }, 'at least one of skills / tools / preset / permission / mcpServers'],
    ['a non-array skills grant', { name: 'research', entry: { skills: 'verify' } }, 'mutation.entry.skills'],
    ['a non-array mcpServers grant', { name: 'research', entry: { mcpServers: 'bbdev' } }, 'mutation.entry.mcpServers'],
    ['an unknown entry key', { name: 'research', entry: { sandbox: 'read-only' } }, 'unknown key "sandbox"'],
    ['a blank preset', { name: 'research', entry: { preset: ' ' } }, 'mutation.entry.preset'],
    ['a blank name', { name: ' ', entry: { preset: 'standard' } }, 'mutation.name'],
  ])('rejects a capability mutation with %s', async (_label, mutation, message) => {
    const svc = await service()
    await svc.propose(capabilityProposal, 'root-1')
    await expect(svc.candidate('c1', VERSION_SET, 'root-1', mutation)).rejects.toThrow(message as string)
  })

  it('accepts a capability mutation granting an MCP server', async () => {
    const svc = await service()
    await svc.propose(capabilityProposal, 'root-1')
    const record = await svc.candidate('c1', VERSION_SET, 'root-1', { name: 'research', entry: { mcpServers: ['bbdev'] } })
    expect(record.status).toBe('candidate')
  })

  it.each([
    ['a baseVersion disagreeing with the proposal', { baseVersion: 'v4', definition: { objective: 'x' } }, 'must equal the proposal\'s baseVersion "v3"'],
    ['a non-object definition', { baseVersion: 'v3', definition: 'text' }, 'non-empty object'],
    ['an empty definition', { baseVersion: 'v3', definition: {} }, 'non-empty object'],
    ['a missing baseVersion', { definition: { objective: 'x' } }, 'mutation.baseVersion'],
  ])('rejects a task_definition mutation with %s', async (_label, mutation, message) => {
    const svc = await service()
    await svc.propose(proposal, 'root-1')
    await expect(svc.candidate('p1', VERSION_SET, 'root-1', mutation)).rejects.toThrow(message as string)
  })

  it.each(['tool', 'decomposition_policy', 'workflow_policy', 'verifier', 'runtime_policy'] as const)(
    'accepts a free-form %s mutation, recorded mechanical: false',
    async targetType => {
      const svc = await service()
      await svc.propose({ ...proposal, proposalId: `m-${targetType}`, targetType, targetId: `${targetType}:1` }, 'root-1')
      await svc.candidate(`m-${targetType}`, VERSION_SET, 'root-1', { sketch: 'free-form patch description', detail: { any: 'shape' } })
      expect((await svc.get(`m-${targetType}`)).mutation).toEqual({ sketch: 'free-form patch description', detail: { any: 'shape' } })
    },
  )

  it('rejects a non-object mutation for any targetType', async () => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    await svc.propose({ ...proposal, proposalId: 'v1', targetType: 'verifier', targetId: 'verifier:build', level: 'L4' }, 'root-1')
    for (const mutation of ['text', ['x'], null]) {
      await expect(svc.candidate('s1', VERSION_SET, 'root-1', mutation)).rejects.toThrow('mutation must be an object')
      await expect(svc.candidate('v1', VERSION_SET, 'root-1', mutation)).rejects.toThrow('mutation must be an object')
    }
  })
})


describe('EvolutionService prepared state machine', () => {
  it('walks candidate(mutation) → prepared → replayed → gated → decided and derives the extended history', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), 'old')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: 'new' })
    const evidenceFile = join(root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await svc.prepare('s1', 'root-1')
    await svc.replay('s1', 'root-1', replayReport('s1', 'skill'))
    const replayed = await svc.get('s1')
    expect(replayed.status).toBe('replayed')
    expect(replayed.replayed).toEqual({
      report: 'sandbox/s1/replay-report.json',
      verdict: 'not-worse',
      tasks: [{ taskId: 't-champion', relation: 'not-worse', holdout: false }],
    })
    expect(JSON.parse(await readFile(join(root, 'sandbox', 's1', 'replay-report.json'), 'utf8')).proposalId).toBe('s1')
    await svc.gate('s1', gateAnswers([evidenceFile, 'sandbox/s1/replay-report.json']), 'root-1')
    const decided = await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-1')
    expect(decided.status).toBe('decided')
    expect(decided.history.map(entry => entry.status)).toEqual(['proposed', 'candidate', 'prepared', 'replayed', 'gated', 'decided'])
  })

  it('rejects gate on a mutation-carrying candidate until it is prepared', async () => {
    const svc = await service()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: 'x' })
    await expect(svc.gate('s1', gateAnswers(['/x']), 'root-1')).rejects.toThrow(/cannot record "gated".*prepared/)
    expect((await svc.get('s1')).status).toBe('candidate')
  })

  it('rejects prepare on a mutation-less candidate and a repeated prepare', async () => {
    const { svc } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1')
    await expect(svc.prepare('s1', 'root-1')).rejects.toThrow('cannot record "prepared"')
    await svc.propose({ ...skillProposal, proposalId: 's2' }, 'root-1')
    await svc.candidate('s2', VERSION_SET, 'root-1', { name: 'verify', content: 'x' })
    await svc.prepare('s2', 'root-1')
    await expect(svc.prepare('s2', 'root-1')).rejects.toThrow('cannot record "prepared"')
  })
})

describe('EvolutionService sandbox materialization', () => {
  it('materializes a skill mutation and snapshots the champion SKILL.md', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), 'old skill text')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: 'new skill text' })
    const prepared = await svc.prepare('s1', 'root-1')
    expect(prepared.status).toBe('prepared')
    expect(prepared.prepared).toEqual({
      sandbox: 'sandbox/s1',
      mechanical: true,
      champion: 'captured',
      files: ['skills/verify/SKILL.md', 'champion/skills/verify/SKILL.md'],
    })
    expect(await readFile(join(root, 'sandbox', 's1', 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe('new skill text')
    expect(await readFile(join(root, 'sandbox', 's1', 'champion', 'skills', 'verify', 'SKILL.md'), 'utf8')).toBe('old skill text')
  })

  it('records champion: "missing" when the production skill does not exist', async () => {
    const { svc, root } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: 'new' })
    const prepared = await svc.prepare('s1', 'root-1')
    expect(prepared.prepared!.champion).toBe('missing')
    expect(prepared.prepared!.files).toEqual(['skills/verify/SKILL.md'])
    expect(existsSync(join(root, 'sandbox', 's1', 'champion'))).toBe(false)
  })

  it('materializes an agent_preset mutation and copies the champion preset directory', async () => {
    const { svc, root, presetRoot } = await serviceWithRoots()
    await mkdir(join(presetRoot, 'bb-verify', 'sub'), { recursive: true })
    await writeFile(join(presetRoot, 'bb-verify', 'preset.yml'), 'preset: old')
    await writeFile(join(presetRoot, 'bb-verify', 'sub', 'note.md'), 'nested note')
    await svc.propose(presetProposal, 'root-1')
    await svc.candidate('pr1', { agentPreset: 'v2' }, 'root-1', {
      presetId: 'bb-verify',
      files: [
        { path: 'preset.yml', content: 'preset: new' },
        { path: 'extra/check.md', content: 'added file' },
      ],
    })
    const prepared = await svc.prepare('pr1', 'root-1')
    expect(prepared.prepared!.champion).toBe('captured')
    expect(prepared.prepared!.files).toEqual([
      '.agent-presets/bb-verify/preset.yml',
      '.agent-presets/bb-verify/extra/check.md',
      'champion/.agent-presets/bb-verify/preset.yml',
      'champion/.agent-presets/bb-verify/sub/note.md',
    ])
    expect(await readFile(join(root, 'sandbox', 'pr1', '.agent-presets', 'bb-verify', 'preset.yml'), 'utf8')).toBe('preset: new')
    expect(await readFile(join(root, 'sandbox', 'pr1', '.agent-presets', 'bb-verify', 'extra', 'check.md'), 'utf8')).toBe('added file')
    expect(await readFile(join(root, 'sandbox', 'pr1', 'champion', '.agent-presets', 'bb-verify', 'preset.yml'), 'utf8')).toBe('preset: old')
    expect(await readFile(join(root, 'sandbox', 'pr1', 'champion', '.agent-presets', 'bb-verify', 'sub', 'note.md'), 'utf8')).toBe('nested note')
  })

  it('materializes a capability mutation as a whole-row patch and snapshots the champion entry (code-default without a config.yml row)', async () => {
    const { svc, root } = await serviceWithRoots()
    await svc.propose(capabilityProposal, 'root-1')
    await svc.candidate('c1', { capabilityTable: 'config.yml#doc1' }, 'root-1', capabilityMutation)
    const prepared = await svc.prepare('c1', 'root-1', { capabilityEntry: { preset: 'standard' } })
    expect(prepared.prepared!.champion).toBe('captured')
    expect(prepared.prepared!.championSource).toBe('code-default')
    expect(prepared.prepared!.files).toEqual(['capability-table.patch.yml', 'champion/capability-table.entry.yml'])
    const patch = await readFile(join(root, 'sandbox', 'c1', 'capability-table.patch.yml'), 'utf8')
    expect(patch).toContain('whole-row replacement')
    expect(patch).toContain('proposal c1')
    expect(JSON.parse(patch.trim().split('\n').at(-1)!)).toEqual({ research: { preset: 'standard', skills: ['verify'] } })
    const champion = await readFile(join(root, 'sandbox', 'c1', 'champion', 'capability-table.entry.yml'), 'utf8')
    expect(JSON.parse(champion.trim().split('\n').at(-1)!)).toEqual({ research: { preset: 'standard' } })
  })

  it('snapshots the config.yml row source text verbatim when the row exists (championSource: config-text)', async () => {
    const { svc, dir, root } = await serviceWithRoots()
    await writeFile(join(dir, 'config.yml'), CONFIG_FIXTURE)
    await svc.propose(capabilityProposal, 'root-1')
    await svc.candidate('c1', { capabilityTable: 'config.yml#doc1' }, 'root-1', capabilityMutation)
    const prepared = await svc.prepare('c1', 'root-1', { capabilityEntry: { skills: [], tools: [], preset: 'standard' } })
    expect(prepared.prepared!.champion).toBe('captured')
    expect(prepared.prepared!.championSource).toBe('config-text')
    expect(prepared.prepared!.files).toEqual([
      'capability-table.patch.yml',
      'champion/capability-table.entry.yml',
      'champion/capability-table.source.txt',
    ])
    // the rollback anchor is the source line byte-for-byte, not the schema-normalized registry entry
    expect(await readFile(join(root, 'sandbox', 'c1', 'champion', 'capability-table.source.txt'), 'utf8'))
      .toBe('      research: { preset: standard }\n')
    const champion = await readFile(join(root, 'sandbox', 'c1', 'champion', 'capability-table.entry.yml'), 'utf8')
    expect(JSON.parse(champion.trim().split('\n').at(-1)!)).toEqual({ research: { skills: [], tools: [], preset: 'standard' } })
  })

  it('requires the caller-resolved capability entry and records champion: "missing" for a new capability', async () => {
    const { svc, root } = await serviceWithRoots()
    await svc.propose(capabilityProposal, 'root-1')
    await svc.candidate('c1', VERSION_SET, 'root-1', capabilityMutation)
    await expect(svc.prepare('c1', 'root-1')).rejects.toThrow('capabilityEntry')
    const prepared = await svc.prepare('c1', 'root-1', { capabilityEntry: null })
    expect(prepared.prepared!.champion).toBe('missing')
    expect(prepared.prepared!.championSource).toBe('missing')
    expect(prepared.prepared!.files).toEqual(['capability-table.patch.yml'])
    expect(existsSync(join(root, 'sandbox', 'c1', 'champion'))).toBe(false)
  })

  it('materializes a task_definition mutation and the champion definition', async () => {
    const { svc, root } = await serviceWithRoots()
    await svc.propose(proposal, 'root-1')
    await svc.candidate('p1', VERSION_SET, 'root-1', { baseVersion: 'v3', definition: { objective: 'new objective' } })
    await expect(svc.prepare('p1', 'root-1')).rejects.toThrow('taskDefinition')
    const championDef = { taskType: 'build', version: 3, objective: 'old objective', acceptanceCriteria: [], requiredCapabilities: [] }
    const prepared = await svc.prepare('p1', 'root-1', { taskDefinition: championDef })
    expect(prepared.prepared!.files).toEqual(['task-definition.json', 'champion/task-definition.json'])
    expect(JSON.parse(await readFile(join(root, 'sandbox', 'p1', 'task-definition.json'), 'utf8'))).toEqual({ objective: 'new objective' })
    expect(JSON.parse(await readFile(join(root, 'sandbox', 'p1', 'champion', 'task-definition.json'), 'utf8'))).toEqual(championDef)
  })

  it.each(['tool', 'decomposition_policy', 'workflow_policy', 'verifier', 'runtime_policy'] as const)(
    'prepares a free-form %s mutation as bookkeeping only: no sandbox dir, then gates',
    async targetType => {
      const { svc, root } = await serviceWithRoots()
      await svc.propose({ ...proposal, proposalId: `m-${targetType}`, targetType, targetId: `${targetType}:1` }, 'root-1')
      await svc.candidate(`m-${targetType}`, VERSION_SET, 'root-1', { sketch: 'free-form patch description' })
      const prepared = await svc.prepare(`m-${targetType}`, 'root-1')
      expect(prepared.prepared).toEqual({ sandbox: null, mechanical: false, champion: 'none', files: [] })
      expect(existsSync(join(root, 'sandbox'))).toBe(false)
      const evidenceFile = join(root, 'regression.log')
      await writeFile(evidenceFile, 'ok')
      await svc.gate(`m-${targetType}`, gateAnswers([evidenceFile]), 'root-1')
      expect((await svc.get(`m-${targetType}`)).status).toBe('gated')
    },
  )

  it('confines every write to the sandbox dir; production roots stay untouched', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), 'old skill text')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: 'new skill text' })
    await svc.prepare('s1', 'root-1')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('old skill text')
    expect((await readdir(root)).sort()).toEqual(['proposals.jsonl', 'sandbox'])
    expect(await readdir(join(root, 'sandbox'))).toEqual(['s1'])
  })

  it('rejects an unsafe proposalId at prepare time, writing nothing', async () => {
    const { svc, root } = await serviceWithRoots()
    await svc.propose({ ...skillProposal, proposalId: '../escape' }, 'root-1')
    await svc.candidate('../escape', VERSION_SET, 'root-1', { name: 'verify', content: 'x' })
    await expect(svc.prepare('../escape', 'root-1')).rejects.toThrow('proposalId')
    expect(existsSync(join(root, 'sandbox'))).toBe(false)
    expect((await svc.get('../escape')).status).toBe('candidate')
  })
})

describe('EvolutionService replay compatibility', () => {
  it('replays a pre-mutation (graph12-era) five-line ledger without drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const lines = [
      { formatVersion: 1, kind: 'proposed', proposalId: 'e1', targetType: 'skill', targetId: 'verify', baseVersion: 'v1', level: 'L2', rationale: 'r1', sourceRefs: ['diagnosis:d1'], actor: 'root-1', at: '2026-09-16T09:00:00.000Z' },
      { formatVersion: 1, kind: 'proposed', proposalId: 'e2', targetType: 'verifier', targetId: 'verifier:build', baseVersion: 'v1', level: 'L4', rationale: 'r2', sourceRefs: ['evidence:ev-1'], actor: 'root-1', at: '2026-09-16T09:05:00.000Z' },
      { formatVersion: 1, kind: 'candidate', proposalId: 'e1', versionSet: { skill: 'v1', verifier: 'v1' }, actor: 'root-1', at: '2026-09-16T09:10:00.000Z' },
      { formatVersion: 1, kind: 'gated', proposalId: 'e1', gate: gateAnswers(['ev-1']), actor: 'root-1', at: '2026-09-16T09:20:00.000Z' },
      { formatVersion: 1, kind: 'decided', proposalId: 'e1', decision: 'PROMOTE', note: 'ok', actor: 'root-1', at: '2026-09-16T09:30:00.000Z' },
    ]
    await writeFile(join(root, 'proposals.jsonl'), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
    const svc = new EvolutionService(fixtureCtx(), { root })
    expect((await svc.list()).map(item => [item.proposalId, item.status])).toEqual([['e2', 'proposed'], ['e1', 'decided']])
    const e1 = await svc.get('e1')
    expect(e1.history.map(entry => entry.status)).toEqual(['proposed', 'candidate', 'gated', 'decided'])
    // the decided line predates approvalRef; the fold tolerates its absence
    expect(e1.decisionApprovalRef).toBeUndefined()
    expect(e1.mutation).toBeUndefined()
    expect(e1.prepared).toBeUndefined()
    // and a mutation-less proposal on a legacy ledger still gates directly
    await svc.candidate('e2', { verifier: 'v1' }, 'root-1')
    const evidenceFile = join(root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await svc.gate('e2', gateAnswers([evidenceFile]), 'root-1')
    expect((await svc.get('e2')).status).toBe('gated')
  })

  it('replays a ledger with prepared records to the same fold as the live service', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), 'old')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', { skill: 'v2' }, 'root-1', { name: 'verify', content: 'new' })
    await svc.prepare('s1', 'root-1')
    const live = await svc.list()
    const reopened = new EvolutionService(fixtureCtx(), { root, skillRoot })
    expect(await reopened.list()).toEqual(live)
    expect((await reopened.get('s1')).prepared).toEqual({
      sandbox: 'sandbox/s1',
      mechanical: true,
      champion: 'captured',
      files: ['skills/verify/SKILL.md', 'champion/skills/verify/SKILL.md'],
    })
  })

  it('fails loud when a replayed prepared record lies about mechanical', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { root })
    await svc.propose({ ...proposal, targetType: 'verifier', targetId: 'verifier:build', level: 'L4' }, 'root-1')
    await svc.candidate('p1', VERSION_SET, 'root-1', { sketch: 'free-form' })
    const forged = { formatVersion: 1, kind: 'prepared', proposalId: 'p1', sandbox: 'sandbox/p1', mechanical: true, champion: 'captured', files: ['x'], actor: 'x', at: 'now' }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    const reopened = new EvolutionService(fixtureCtx(), { root })
    await expect(reopened.list()).rejects.toThrow('mechanical')
  })

  it('fails loud on a forged championSource: unknown value, non-capability target, or disagreement with champion', async () => {
    const forge = async (targetType: 'capability' | 'skill', record: Record<string, unknown>) => {
      const root = await mkdtemp(join(tmpdir(), 'evolution-'))
      const svc = new EvolutionService(fixtureCtx(), { root })
      const input = targetType === 'capability' ? capabilityProposal : skillProposal
      await svc.propose(input, 'root-1')
      await svc.candidate(input.proposalId, VERSION_SET, 'root-1', targetType === 'capability' ? capabilityMutation : { name: 'verify', content: 'x' })
      await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(record)}\n`, { flag: 'a' })
      return new EvolutionService(fixtureCtx(), { root })
    }
    const base = { formatVersion: 1, kind: 'prepared', sandbox: 'sandbox/c1', mechanical: true, champion: 'captured', files: ['x'], actor: 'x', at: 'now' }
    await expect((await forge('capability', { ...base, proposalId: 'c1', championSource: 'bogus' })).list()).rejects.toThrow('unknown championSource "bogus"')
    await expect((await forge('skill', { ...base, proposalId: 's1', sandbox: 'sandbox/s1', championSource: 'config-text' })).list()).rejects.toThrow('not capability')
    await expect((await forge('capability', { ...base, proposalId: 'c1', champion: 'missing', championSource: 'code-default' })).list()).rejects.toThrow('but champion "missing"')

    // a valid pre-W19 record (no championSource) folds unchanged
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { root })
    await svc.propose(capabilityProposal, 'root-1')
    await svc.candidate('c1', VERSION_SET, 'root-1', capabilityMutation)
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify({ ...base, proposalId: 'c1' })}\n`, { flag: 'a' })
    const reopened = new EvolutionService(fixtureCtx(), { root })
    expect((await reopened.get('c1')).prepared).toEqual({ sandbox: 'sandbox/c1', mechanical: true, champion: 'captured', files: ['x'] })
  })

  it('fails loud on a forged candidate or gated record: the fold reruns the write-path payload checks', async () => {
    // an empty version set would never survive candidate()
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { root })
    await svc.propose(proposal, 'root-1')
    const forgedCandidate = { formatVersion: 1, kind: 'candidate', proposalId: 'p1', versionSet: {}, actor: 'x', at: 'now' }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forgedCandidate)}\n`, { flag: 'a' })
    const reopened = new EvolutionService(fixtureCtx(), { root })
    await expect(reopened.list()).rejects.toThrow('at least one version')

    // an empty gate answer would never survive gate()
    const root2 = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc2 = new EvolutionService(fixtureCtx(), { root: root2 })
    await svc2.propose(proposal, 'root-1')
    await svc2.candidate('p1', VERSION_SET, 'root-1')
    const emptyAnswer = { formatVersion: 1, kind: 'gated', proposalId: 'p1', gate: { ...gateAnswers(['ev-1']), targetFailureFixed: '' }, actor: 'x', at: 'now' }
    await writeFile(join(root2, 'proposals.jsonl'), `${JSON.stringify(emptyAnswer)}\n`, { flag: 'a' })
    const reopened2 = new EvolutionService(fixtureCtx(), { root: root2 })
    await expect(reopened2.list()).rejects.toThrow('Target failure fixed')

    // zero regression evidence refs would never survive gate() either
    const root3 = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc3 = new EvolutionService(fixtureCtx(), { root: root3 })
    await svc3.propose(proposal, 'root-1')
    await svc3.candidate('p1', VERSION_SET, 'root-1')
    const noEvidence = { formatVersion: 1, kind: 'gated', proposalId: 'p1', gate: gateAnswers([]), actor: 'x', at: 'now' }
    await writeFile(join(root3, 'proposals.jsonl'), `${JSON.stringify(noEvidence)}\n`, { flag: 'a' })
    const reopened3 = new EvolutionService(fixtureCtx(), { root: root3 })
    await expect(reopened3.list()).rejects.toThrow('at least one evidence ref')
  })
})


describe('evolution_prepare tool', () => {
  it('evolution_candidate accepts a structured mutation and points at evolution_prepare', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...capabilityProposal }, exec('root-1'))
    const result = (await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 'c1', versionSet: { capabilityTable: 'config.yml#doc1' }, mutation: capabilityMutation },
      exec('root-1'),
    )) as string
    expect(result).toContain('[candidate] version set: capabilityTable=config.yml#doc1')
    expect(result).toContain('next: evolution_prepare')
    expect((await svc.get('c1')).mutation).toEqual(capabilityMutation)
  })

  it('evolution_candidate surfaces a schema violation without recording', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...skillProposal }, exec('root-1'))
    const result = (await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 's1', versionSet: VERSION_SET, mutation: { name: 'a/b', content: 'x' } },
      exec('root-1'),
    )) as string
    expect(result).toContain('evolution_candidate rejected:')
    expect(result).toContain('mutation.name')
    expect((await svc.get('s1')).status).toBe('proposed')
  })

  it('evolution_prepare resolves the capability champion from taskRuntime and writes the patch', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...capabilityProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute({ proposalId: 'c1', versionSet: VERSION_SET, mutation: capabilityMutation }, exec('root-1'))
    const result = (await defineEvolutionPrepareTool(ctx).execute({ proposalId: 'c1' }, exec('root-1'))) as string
    expect(result).toContain('proposal c1 [prepared]')
    expect(result).toContain('wrote capability-table.patch.yml')
    expect(result).toContain('champion snapshot: captured')
    expect(result).toContain('production was not touched')
    const patch = await readFile(join(svc.root, 'sandbox', 'c1', 'capability-table.patch.yml'), 'utf8')
    expect(JSON.parse(patch.trim().split('\n').at(-1)!)).toEqual({ research: { preset: 'standard', skills: ['verify'] } })
    const champion = await readFile(join(svc.root, 'sandbox', 'c1', 'champion', 'capability-table.entry.yml'), 'utf8')
    expect(JSON.parse(champion.trim().split('\n').at(-1)!)).toEqual({ research: { preset: 'standard' } })
  })

  it('evolution_prepare snapshots the task_definition champion from the task store', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const raw = ctx as unknown as { task: { openStore: ReturnType<typeof vi.fn> } }
    raw.task.openStore = vi.fn(async () => ({
      tasks: [
        {
          taskId: 't1',
          definitionRef: { taskType: 'build', version: 3 },
          objective: 'old objective',
          acceptanceCriteria: [{ criterionId: 'ac1' }],
          requestedCapabilities: ['design-ball'],
        },
      ],
      diagnoses: [], obligations: [],
      evidence: [],
    }))
    await defineEvolutionProposeTool(ctx).execute({ ...proposal, targetId: 'build' }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 'p1', versionSet: VERSION_SET, mutation: { baseVersion: 'v3', definition: { objective: 'new objective' } } },
      exec('root-1'),
    )
    const result = (await defineEvolutionPrepareTool(ctx).execute({ proposalId: 'p1' }, exec('root-1'))) as string
    expect(result).toContain('proposal p1 [prepared]')
    expect(result).toContain('champion snapshot: captured')
    expect(JSON.parse(await readFile(join(svc.root, 'sandbox', 'p1', 'task-definition.json'), 'utf8'))).toEqual({ objective: 'new objective' })
    expect(JSON.parse(await readFile(join(svc.root, 'sandbox', 'p1', 'champion', 'task-definition.json'), 'utf8'))).toEqual({
      taskType: 'build',
      version: 3,
      objective: 'old objective',
      acceptanceCriteria: [{ criterionId: 'ac1' }],
      requiredCapabilities: ['design-ball'],
    })
  })

  it('evolution_prepare records champion: null when no task instance matches the base version', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    // the toolCtx store snapshot carries no tasks at all — the base definition is unresolvable
    await defineEvolutionProposeTool(ctx).execute({ ...proposal, targetId: 'build' }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute(
      { proposalId: 'p1', versionSet: VERSION_SET, mutation: { baseVersion: 'v3', definition: { objective: 'new' } } },
      exec('root-1'),
    )
    const result = (await defineEvolutionPrepareTool(ctx).execute({ proposalId: 'p1' }, exec('root-1'))) as string
    expect(result).toContain('champion: null')
    expect((await svc.get('p1')).prepared!.champion).toBe('missing')
  })

  it('evolution_prepare rejects an unknown proposal and a candidate without a mutation', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    const tool = defineEvolutionPrepareTool(ctx)
    const missing = (await tool.execute({ proposalId: 'ghost' }, exec('root-1'))) as string
    expect(missing).toContain('evolution_prepare rejected:')
    expect(missing).toContain('unknown proposal "ghost"')
    await defineEvolutionProposeTool(ctx).execute({ ...proposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute({ proposalId: 'p1', versionSet: VERSION_SET }, exec('root-1'))
    const result = (await tool.execute({ proposalId: 'p1' }, exec('root-1'))) as string
    expect(result).toContain('cannot record "prepared"')
    expect((await svc.get('p1')).status).toBe('candidate')
  })

  it('evolution_gate rejects a mutation-carrying candidate until it is prepared', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...capabilityProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute({ proposalId: 'c1', versionSet: VERSION_SET, mutation: capabilityMutation }, exec('root-1'))
    const result = (await defineEvolutionGateTool(ctx).execute({ proposalId: 'c1', ...gateAnswers(['ev-1']) }, exec('root-1'))) as string
    expect(result).toContain('cannot record "gated"')
    expect(result).toContain('evolution_prepare')
    expect((await svc.get('c1')).status).toBe('candidate')
  })

  it('evolution_list renders the prepared status with sandbox path and champion state', async () => {
    const svc = await service()
    const { ctx } = toolCtx(svc)
    await defineEvolutionProposeTool(ctx).execute({ ...capabilityProposal }, exec('root-1'))
    await defineEvolutionCandidateTool(ctx).execute({ proposalId: 'c1', versionSet: VERSION_SET, mutation: capabilityMutation }, exec('root-1'))
    await defineEvolutionPrepareTool(ctx).execute({ proposalId: 'c1' }, exec('root-1'))
    const list = defineEvolutionListTool(ctx)
    const all = (await list.execute({})) as string
    expect(all).toContain('- c1 [prepared] L2 capability research (base v1)')
    expect(all).toContain('mutation: mechanical capability mutation')
    expect(all).toContain(`sandbox: ${svc.root}/sandbox/c1 (2 files, champion snapshot captured)`)
    expect(all).toContain('history: proposed by root-1')
    const filtered = (await list.execute({ status: 'prepared' })) as string
    expect(filtered).toContain('evolution ledger (1):')
    const gated = (await list.execute({ status: 'gated' })) as string
    expect(gated).toBe('evolution ledger: no proposals match')
  })
})


describe('EvolutionService replay', () => {
  it('rejects gate on a prepared mechanical mutation until it is replayed, pointing at evolution_replay', async () => {
    const { svc } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: 'x' })
    await svc.prepare('s1', 'root-1')
    await expect(svc.gate('s1', gateAnswers(['/x']), 'root-1')).rejects.toThrow(/cannot record "gated".*evolution_replay/)
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it('rejects replay on a candidate and a repeated replay', async () => {
    const { svc } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: 'x' })
    await expect(svc.replay('s1', 'root-1', replayReport('s1', 'skill'))).rejects.toThrow('cannot record "replayed"')
    await svc.prepare('s1', 'root-1')
    await svc.replay('s1', 'root-1', replayReport('s1', 'skill'))
    await expect(svc.replay('s1', 'root-1', replayReport('s1', 'skill'))).rejects.toThrow('cannot record "replayed"')
  })

  it('lets a bookkeeping-only (non-mechanical) prepared proposal gate without a replay', async () => {
    const { svc, root } = await serviceWithRoots()
    await svc.propose({ ...proposal, proposalId: 'w1', targetType: 'workflow_policy', targetId: 'workflow:1' }, 'root-1')
    await svc.candidate('w1', VERSION_SET, 'root-1', { sketch: 'free-form' })
    await svc.prepare('w1', 'root-1')
    const evidenceFile = join(root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await svc.gate('w1', gateAnswers([evidenceFile]), 'root-1')
    expect((await svc.get('w1')).status).toBe('gated')
  })

  it('keeps the manual path intact: a mutation-less candidate gates directly', async () => {
    const svc = await service()
    await svc.propose(proposal, 'root-1')
    await svc.candidate('p1', VERSION_SET, 'root-1')
    await expect(svc.replay('p1', 'root-1', replayReport('p1', 'task_definition'))).rejects.toThrow('cannot record "replayed"')
    const evidenceFile = join(svc.root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await svc.gate('p1', gateAnswers([evidenceFile]), 'root-1')
    expect((await svc.get('p1')).status).toBe('gated')
  })

  it('requires the gate of a replayed proposal to cite the replay report, and the report to still exist', async () => {
    const { svc, root } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: 'x' })
    await svc.prepare('s1', 'root-1')
    await svc.replay('s1', 'root-1', replayReport('s1', 'skill'))
    const evidenceFile = join(root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await expect(svc.gate('s1', gateAnswers([evidenceFile]), 'root-1'))
      .rejects.toThrow('must cite the replay report "sandbox/s1/replay-report.json"')
    await svc.gate('s1', gateAnswers([evidenceFile, 'sandbox/s1/replay-report.json']), 'root-1')
    expect((await svc.get('s1')).status).toBe('gated')
  })

  it('fails the gate when the replay report was deleted after the replay', async () => {
    const { svc, root } = await serviceWithRoots()
    const { rm } = await import('node:fs/promises')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: 'x' })
    await svc.prepare('s1', 'root-1')
    await svc.replay('s1', 'root-1', replayReport('s1', 'skill'))
    await rm(join(root, 'sandbox', 's1', 'replay-report.json'))
    await expect(svc.gate('s1', gateAnswers(['sandbox/s1/replay-report.json']), 'root-1'))
      .rejects.toThrow('no longer exists under the ledger root')
  })

  it('accepts a manual report only for agent_preset proposals', async () => {
    const { svc } = await serviceWithRoots()
    await svc.propose(presetProposal, 'root-1')
    await svc.candidate('pr1', VERSION_SET, 'root-1', { presetId: 'bb-verify', files: [{ path: 'preset.yml', content: 'x' }] })
    await svc.prepare('pr1', 'root-1')
    const manual = replayReport('pr1', 'agent_preset', {
      mode: 'manual',
      manualReason: 'the roster cannot mount sandbox presets',
      observed: [],
      verdict: 'manual',
    })
    const replayed = await svc.replay('pr1', 'root-1', manual)
    expect(replayed.status).toBe('replayed')
    expect(replayed.replayed!.verdict).toBe('manual')

    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: 'x' })
    await svc.prepare('s1', 'root-1')
    await expect(svc.replay('s1', 'root-1', replayReport('s1', 'skill', {
      mode: 'manual',
      manualReason: 'skip it',
      observed: [],
      verdict: 'manual',
    }))).rejects.toThrow('only valid for agent_preset')
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it.each([
    ['a mismatched proposalId', { proposalId: 'someone-else' }, 'does not match'],
    ['a bad formatVersion', { formatVersion: 2 }, 'formatVersion'],
    ['an executed report with no observed task', { observed: [] }, 'at least one observed'],
    ['a holdout block whose flag disagrees with its tasks', { holdout: { executed: false, tasks: [{ taskId: 't1', champion: { taskId: 't1', outcome: 'verified' }, relation: 'not-worse' }] } }, 'holdout'],
    ['an unknown verdict', { verdict: 'great' }, 'verdict'],
    ['an unknown relation', { observed: [{ taskId: 't1', champion: { taskId: 't1', outcome: 'verified' }, relation: 'better' }] }, 'relation'],
  ])('rejects a report with %s', async (_label, patch, message) => {
    const { svc } = await serviceWithRoots()
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: 'x' })
    await svc.prepare('s1', 'root-1')
    await expect(svc.replay('s1', 'root-1', replayReport('s1', 'skill', patch))).rejects.toThrow(message as string)
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it('replays a ledger with a replayed record to the same fold after reopen', async () => {
    const { svc, root, skillRoot } = await serviceWithRoots()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), 'old')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: 'x' })
    await svc.prepare('s1', 'root-1')
    await svc.replay('s1', 'root-1', replayReport('s1', 'skill'))
    const live = await svc.list()
    const reopened = new EvolutionService(fixtureCtx(), { root, skillRoot })
    expect(await reopened.list()).toEqual(live)
    expect((await reopened.get('s1')).status).toBe('replayed')
  })

  it('fails loud when a replayed replayed record carries an unknown verdict', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc = new EvolutionService(fixtureCtx(), { root })
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: 'x' })
    await svc.prepare('s1', 'root-1')
    const forged = {
      formatVersion: 1, kind: 'replayed', proposalId: 's1', report: 'sandbox/s1/replay-report.json',
      verdict: 'great', tasks: [], actor: 'x', at: 'now',
    }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    const reopened = new EvolutionService(fixtureCtx(), { root })
    await expect(reopened.list()).rejects.toThrow('unknown verdict')
  })
})

describe('replay comparison', () => {
  const base = { taskId: 't1', outcome: 'verified' as const, criteria: [{ criterionId: 'ac1', verdict: 'pass' as const }] }

  it('matching sides compare not-worse with verdictMatch', () => {
    const result = compareReplaySides(base, { ...base })
    expect(result).toEqual({ verdictMatch: true, criteriaDiff: [], relation: 'not-worse' })
  })

  it('a failed candidate against a verified champion is worse', () => {
    const result = compareReplaySides(base, { ...base, outcome: 'failed', criteria: [{ criterionId: 'ac1', verdict: 'fail' }] })
    expect(result.relation).toBe('worse')
    expect(result.verdictMatch).toBe(false)
    expect(result.criteriaDiff).toEqual([{ criterionId: 'ac1', champion: 'pass', candidate: 'fail' }])
  })

  it('a shared criterion flipping pass → fail is a regression even when the outcome holds', () => {
    const result = compareReplaySides(
      { ...base, criteria: [{ criterionId: 'ac1', verdict: 'pass' }, { criterionId: 'ac2', verdict: 'fail' }] },
      { ...base, outcome: 'failed', criteria: [{ criterionId: 'ac1', verdict: 'fail' }, { criterionId: 'ac2', verdict: 'fail' }] },
    )
    // failed vs failed ranks equal, but ac1 flipped pass → fail
    expect(result.relation).toBe('worse')
  })

  it('a candidate fixing a failed champion is not-worse', () => {
    const champion = { taskId: 't1', outcome: 'failed' as const, criteria: [{ criterionId: 'ac1', verdict: 'fail' as const }] }
    const result = compareReplaySides(champion, { taskId: 't1', outcome: 'verified', criteria: [{ criterionId: 'ac1', verdict: 'pass' }] })
    expect(result.relation).toBe('not-worse')
    expect(result.verdictMatch).toBe(false)
  })

  it('an added or removed criterion is a diff without a regression', () => {
    const result = compareReplaySides(base, { ...base, criteria: [{ criterionId: 'ac1', verdict: 'pass' }, { criterionId: 'ac2', verdict: 'pass' }] })
    expect(result.relation).toBe('not-worse')
    expect(result.verdictMatch).toBe(false)
    expect(result.criteriaDiff).toEqual([{ criterionId: 'ac2', candidate: 'pass' }])
  })

  it('a cancelled candidate run is inconclusive, not worse', () => {
    const result = compareReplaySides(base, { ...base, outcome: 'cancelled' as const })
    expect(result.relation).toBe('inconclusive')
  })

  it('the overall verdict lets any regression win and holds back on inconclusive', () => {
    expect(overallReplayVerdict([{ relation: 'not-worse' }, { relation: 'worse' }])).toBe('worse')
    expect(overallReplayVerdict([{ relation: 'not-worse' }, { relation: 'inconclusive' }])).toBe('inconclusive')
    expect(overallReplayVerdict([{ relation: 'not-worse' }])).toBe('not-worse')
    expect(overallReplayVerdict([])).toBe('inconclusive')
  })
})

/** A terminal champion task plus its review record, as the replay tool's store fixture. */
const championTask = {
  taskId: 't-champ',
  definitionRef: { taskType: 'subtask', version: 1 },
  parentTaskId: 't-parent',
  objective: 'champion objective',
  depth: 1,
  acceptanceCriteria: [{ criterionId: 'ac1-1', description: 'works', verificationMode: 'deterministic', requiredEvidence: [], mandatory: true, command: 'true' }],
  requestedCapabilities: ['research'],
  decompositionStatus: 'leaf',
  status: 'verified',
  runIds: ['r-champ'],
  childTaskIds: [],
}
const championReview = {
  taskId: 't-champ',
  runId: 'r-champ',
  sessionId: 's-champ',
  outcome: 'verified',
  evidenceRefs: ['ev-champ'],
  anomalies: [],
  durationMs: 42,
  criteria: [{ criterionId: 'ac1-1', verdict: 'pass', command: 'true', exitCode: 0 }],
}

/** Tool context whose taskRuntime.replayTask is a mock and whose store holds the champion fixture. */
function replayToolCtx(svc: EvolutionService, replayTask: ReturnType<typeof vi.fn>) {
  const ctx = {
    reflect: { provide: () => {} },
    effect: () => {},
    evolution: svc,
    approval: { request: vi.fn(async () => 'allowed-once') },
    graphs: { graphForSession: vi.fn(async () => graph) },
    taskRuntime: {
      listCapabilities: vi.fn(() => ({ research: { preset: 'standard' } })),
      replayTask,
    },
    task: {
      openStore: vi.fn(async () => ({
        tasks: [championTask],
        reviews: [championReview],
        diagnoses: [], obligations: [],
        evidence: [{ evidenceId: 'ev-champ' }],
      })),
    },
  }
  return { ctx: ctx as never }
}

const replayOutcome = {
  taskId: 't-cand',
  runId: 'r-cand',
  status: 'verified' as const,
  durationMs: 5,
  criteria: [{ criterionId: 'ac1-1', verdict: 'pass' as const, command: 'true', exitCode: 0 }],
}

describe('evolution_replay tool', () => {
  async function preparedProposal(targetType: 'capability' | 'skill' | 'task_definition' | 'agent_preset') {
    const { svc, root } = await serviceWithRoots()
    const replayTask = vi.fn(async () => ({ ...replayOutcome }))
    const { ctx } = replayToolCtx(svc, replayTask)
    const proposeTool = defineEvolutionProposeTool(ctx)
    const candidateTool = defineEvolutionCandidateTool(ctx)
    const prepareTool = defineEvolutionPrepareTool(ctx)
    const replayTool = defineEvolutionReplayTool(ctx)
    const id = `p-${targetType}`
    const proposals = {
      capability: { ...capabilityProposal, proposalId: id },
      skill: { ...skillProposal, proposalId: id },
      task_definition: { ...proposal, proposalId: id, targetId: 'build' },
      agent_preset: { ...presetProposal, proposalId: id },
    } as const
    const mutations = {
      capability: capabilityMutation,
      skill: { name: 'verify', content: 'new skill text' },
      task_definition: { baseVersion: 'v3', definition: { acceptanceCriteria: [{ criterionId: 'ac1-1', command: 'make test' }] } },
      agent_preset: { presetId: 'bb-verify', files: [{ path: 'preset.yml', content: 'preset: new' }] },
    } as const
    await proposeTool.execute({ ...proposals[targetType] }, exec('root-1'))
    await candidateTool.execute({ proposalId: id, versionSet: VERSION_SET, mutation: mutations[targetType] }, exec('root-1'))
    await prepareTool.execute({ proposalId: id }, exec('root-1'))
    return { svc, root, ctx, replayTask, replayTool, id }
  }

  it('rejects a proposal that is not prepared and a bookkeeping-only one', async () => {
    const svc = await service()
    const replayTask = vi.fn(async () => ({ ...replayOutcome }))
    const { ctx } = replayToolCtx(svc, replayTask)
    const tool = defineEvolutionReplayTool(ctx)
    const missing = (await tool.execute({ proposalId: 'ghost', taskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(missing).toContain('unknown proposal "ghost"')
    await defineEvolutionProposeTool(ctx).execute({ ...capabilityProposal }, exec('root-1'))
    const early = (await tool.execute({ proposalId: 'c1', taskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(early).toContain('is proposed; only a prepared proposal can be replayed')

    // bookkeeping-only mutation: prepared with mechanical: false → gate directly
    await defineEvolutionProposeTool(ctx).execute(
      { ...proposal, proposalId: 'w1', targetType: 'workflow_policy', targetId: 'workflow:1' },
      exec('root-1'),
    )
    await defineEvolutionCandidateTool(ctx).execute({ proposalId: 'w1', versionSet: VERSION_SET, mutation: { sketch: 'x' } }, exec('root-1'))
    await defineEvolutionPrepareTool(ctx).execute({ proposalId: 'w1' }, exec('root-1'))
    const bookkeeping = (await tool.execute({ proposalId: 'w1', taskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(bookkeeping).toContain('bookkeeping-only')
    expect(replayTask).not.toHaveBeenCalled()
  })

  it('replays a capability proposal under the whole-row overlay and records the report', async () => {
    const { svc, root, replayTask, replayTool, id } = await preparedProposal('capability')
    const result = (await replayTool.execute({ proposalId: id, taskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(result).toContain(`proposal ${id} [replayed] capability research — verdict: not-worse`)
    expect(result).toContain('t-champ champion verified → candidate verified')
    expect(result).toContain('holdout: not run')
    expect(result).toContain(`report: sandbox/${id}/replay-report.json`)

    expect(replayTask).toHaveBeenCalledOnce()
    const [storeId, championTaskId, options, caller] = replayTask.mock.calls[0]!
    expect(storeId).toBe('sg-t-root-1')
    expect(championTaskId).toBe('t-champ')
    expect(caller).toBe('root-1')
    expect(options).toMatchObject({
      lineage: `evolution-replay:${id}`,
      overlay: { capabilityOverrides: { research: { preset: 'standard', skills: ['verify'] } } },
    })

    const report = JSON.parse(await readFile(join(root, 'sandbox', id, 'replay-report.json'), 'utf8'))
    expect(report.mode).toBe('executed')
    expect(report.observed).toHaveLength(1)
    expect(report.observed[0].champion).toMatchObject({ taskId: 't-champ', outcome: 'verified', durationMs: 42 })
    expect(report.observed[0].candidate).toMatchObject({ taskId: 't-cand', outcome: 'verified' })
    expect(report.observed[0].verdictMatch).toBe(true)
    expect(report.holdout).toEqual({ executed: false, tasks: [] })
    expect(report.verdict).toBe('not-worse')

    const saved = await svc.get(id)
    expect(saved.status).toBe('replayed')
    expect(saved.replayed).toEqual({
      report: `sandbox/${id}/replay-report.json`,
      verdict: 'not-worse',
      tasks: [{ taskId: 't-champ', relation: 'not-worse', holdout: false }],
    })
  })

  it('replays a skill proposal with the sandbox skills dir as the only overlay', async () => {
    const { root, replayTask, replayTool, id } = await preparedProposal('skill')
    const result = (await replayTool.execute({ proposalId: id, taskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(result).toContain('[replayed] skill verify')
    expect(replayTask.mock.calls[0]![2]).toMatchObject({
      overlay: { extraSkillRoots: [join(root, 'sandbox', id, 'skills')] },
    })
    expect(replayTask.mock.calls[0]![2].spawn).toBeUndefined()
  })

  it('replays a task_definition proposal as a deterministic criteria replay of the candidate definition', async () => {
    const { replayTask, replayTool, id } = await preparedProposal('task_definition')
    const result = (await replayTool.execute({ proposalId: id, taskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(result).toContain('[replayed] task_definition build')
    expect(replayTask.mock.calls[0]![2]).toMatchObject({
      spawn: false,
      contract: {
        objective: 'champion objective',
        acceptanceCriteria: [{
          criterionId: 'ac1-1',
          command: 'make test',
          verificationMode: 'deterministic',
          mandatory: true,
        }],
        requiredCapabilities: ['research'],
      },
    })
  })

  it('marks an agent_preset proposal manual and executes nothing', async () => {
    const { svc, replayTask, replayTool, id } = await preparedProposal('agent_preset')
    const result = (await replayTool.execute({ proposalId: id, taskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(result).toContain('[replayed] manual — nothing was executed')
    expect(result).toContain('preset')
    expect(replayTask).not.toHaveBeenCalled()
    const saved = await svc.get(id)
    expect(saved.status).toBe('replayed')
    expect(saved.replayed!.verdict).toBe('manual')
  })

  it('reports a regressing candidate as worse, per task and overall', async () => {
    const { svc, root, ctx, id } = await preparedProposal('capability')
    const raw = ctx as unknown as { taskRuntime: { replayTask: ReturnType<typeof vi.fn> } }
    raw.taskRuntime.replayTask = vi.fn(async () => ({
      ...replayOutcome,
      status: 'failed' as const,
      criteria: [{ criterionId: 'ac1-1', verdict: 'fail' as const, command: 'true', exitCode: 1 }],
    }))
    const tool = defineEvolutionReplayTool(ctx)
    const result = (await tool.execute({ proposalId: id, taskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(result).toContain('verdict: worse')
    expect(result).toContain('champion verified → candidate failed (ac1-1 pass→fail) — worse')
    const report = JSON.parse(await readFile(join(root, 'sandbox', id, 'replay-report.json'), 'utf8'))
    expect(report.verdict).toBe('worse')
    expect(report.observed[0].criteriaDiff).toEqual([{ criterionId: 'ac1-1', champion: 'pass', candidate: 'fail' }])
    expect((await svc.get(id)).replayed!.verdict).toBe('worse')
  })

  it('groups holdout tasks separately and marks them in the ledger', async () => {
    const { svc, ctx, replayTask, replayTool, id } = await preparedProposal('capability')
    const raw = ctx as unknown as { task: { openStore: ReturnType<typeof vi.fn> } }
    const holdoutTask = { ...championTask, taskId: 't-holdout', runIds: ['r-holdout'] }
    const holdoutReview = { ...championReview, taskId: 't-holdout', runId: 'r-holdout' }
    raw.task.openStore = vi.fn(async () => ({
      tasks: [championTask, holdoutTask],
      reviews: [championReview, holdoutReview],
      diagnoses: [], obligations: [],
      evidence: [],
    }))
    const result = (await replayTool.execute({ proposalId: id, taskIds: ['t-champ'], holdoutTaskIds: ['t-holdout'] }, exec('root-1'))) as string
    expect(replayTask).toHaveBeenCalledTimes(2)
    expect(result).toContain('observed (1):')
    expect(result).toContain('holdout (1):')
    const saved = await svc.get(id)
    expect(saved.replayed!.tasks).toEqual([
      { taskId: 't-champ', relation: 'not-worse', holdout: false },
      { taskId: 't-holdout', relation: 'not-worse', holdout: true },
    ])
  })

  it('rejects overlapping task lists, unknown tasks, non-terminal tasks, and tasks without a review record', async () => {
    const { ctx, replayTask, replayTool, id } = await preparedProposal('capability')
    const overlap = (await replayTool.execute({ proposalId: id, taskIds: ['t-champ'], holdoutTaskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(overlap).toContain('must not overlap or repeat')
    const unknown = (await replayTool.execute({ proposalId: id, taskIds: ['t-ghost'] }, exec('root-1'))) as string
    expect(unknown).toContain('unknown task "t-ghost"')

    const raw = ctx as unknown as { task: { openStore: ReturnType<typeof vi.fn> } }
    raw.task.openStore = vi.fn(async () => ({
      tasks: [{ ...championTask, status: 'running' }],
      reviews: [],
      diagnoses: [], obligations: [],
      evidence: [],
    }))
    const running = (await replayTool.execute({ proposalId: id, taskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(running).toContain('is running; only a terminal')
    raw.task.openStore = vi.fn(async () => ({
      tasks: [championTask],
      reviews: [],
      diagnoses: [], obligations: [],
      evidence: [],
    }))
    const noRecord = (await replayTool.execute({ proposalId: id, taskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(noRecord).toContain('has no review record')
    expect(replayTask).not.toHaveBeenCalled()
    expect((await ctx.evolution.get(id)).status).toBe('prepared')
  })

  it('records nothing when a replay run throws mid-flight, and says so', async () => {
    const { svc, ctx, replayTool, id } = await preparedProposal('capability')
    const raw = ctx as unknown as { taskRuntime: { replayTask: ReturnType<typeof vi.fn> } }
    raw.taskRuntime.replayTask = vi.fn(async () => {
      throw new Error('task-runtime: replay of "t-champ" cannot run: capability gap [research] under the overlay')
    })
    const result = (await replayTool.execute({ proposalId: id, taskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(result).toContain('evolution_replay rejected:')
    expect(result).toContain('capability gap')
    expect(result).toContain('no replay was recorded')
    expect((await svc.get(id)).status).toBe('prepared')
  })

  it('evolution_gate after a replay requires the report path among the evidence refs', async () => {
    const { ctx, replayTool, id } = await preparedProposal('capability')
    await replayTool.execute({ proposalId: id, taskIds: ['t-champ'] }, exec('root-1'))
    const gate = defineEvolutionGateTool(ctx)
    const missing = (await gate.execute({ proposalId: id, ...gateAnswers(['ev-champ']) }, exec('root-1'))) as string
    expect(missing).toContain('must cite the replay report')
    const gated = (await gate.execute(
      { proposalId: id, ...gateAnswers([`sandbox/${id}/replay-report.json`, 'ev-champ']) },
      exec('root-1'),
    )) as string
    expect(gated).toContain('[gated] gate answered 6/6')
    expect((await ctx.evolution.get(id)).status).toBe('gated')
  })
})


/* ------------------------------------------------------------------ */
/* W16: decided(PROMOTE) → applied → rolledback — the apply/rollback   */
/* mechanism with its own human-approval gate (guide §2.7.7/§2.9.2).   */
/* ------------------------------------------------------------------ */

/** Two-document config.yml fixture; document 2 carries a decoy `research:` row to prove edits never cross the `---`. */
const CONFIG_FIXTURE = [
  '# Copy to config.yml, fill values.',
  '# Document 1: the profile patch list.',
  '- id: github-bot',
  '  config:',
  '    orgs: {}',
  '',
  '# Singularity task runtime row.',
  '- id: task-runtime',
  '  config:',
  '    # capability name → skills / tool labels / agent preset',
  '    capabilities:',
  '      design-chip: { skills: [chip-designer] }',
  '      research: { preset: standard }',
  '    defaultPreset: standard',
  '',
  '---',
  '# Document 2: the api block.',
  'api:',
  '  upstream: https://example.invalid',
  '  key: sk-test',
  '  research: { preset: decoy }',
  '',
].join('\n')

/** Service whose ledger root, production roots, and config.yml fixture all live in one fresh temp dir. */
async function serviceWithProduction() {
  const dir = await mkdtemp(join(tmpdir(), 'evolution-'))
  const root = join(dir, 'evolution')
  const skillRoot = join(dir, 'skills')
  const presetRoot = join(dir, '.agent-presets')
  const configFile = join(dir, 'config.yml')
  await writeFile(configFile, CONFIG_FIXTURE)
  const svc = new EvolutionService(fixtureCtx(), { root, skillRoot, presetRoot, configFile })
  return { svc, dir, root, skillRoot, presetRoot, configFile }
}

type PrepareChampionInput = Parameters<EvolutionService['prepare']>[2]

/** Walk a mechanical proposal to decided(PROMOTE) at the service level (tools add their own approval gate). */
async function walkToDecided(
  svc: EvolutionService,
  input: ProposeInput,
  mutation: unknown,
  champion: PrepareChampionInput = {},
) {
  await svc.propose(input, 'root-1')
  await svc.candidate(input.proposalId, VERSION_SET, 'root-1', mutation)
  await svc.prepare(input.proposalId, 'root-1', champion)
  await svc.replay(input.proposalId, 'root-1', replayReport(input.proposalId, input.targetType))
  await svc.gate(input.proposalId, gateAnswers([`sandbox/${input.proposalId}/replay-report.json`]), 'root-1')
  await svc.decide(input.proposalId, 'PROMOTE', 'root-1', 'approval:call-0')
}

/** Everything after the first `---` line — document 2 must survive every edit byte for byte. */
function doc2(text: string): string {
  return text.slice(text.indexOf('---'))
}

/** Does this line open a block (`key:` with no inline value, or a `- ` sequence item)? */
function opensBlock(trimmed: string): boolean {
  if (trimmed === '-' || trimmed.startsWith('- ')) return true
  return trimmed.replace(/\s+#.*$/, '').endsWith(':')
}

/**
 * Structural check for the block-YAML subset `config.yml` uses — nested
 * mappings, `- ` sequence items, one-line flow values, comments, blank lines.
 * No YAML parser is a dependency anywhere in this workspace, so "the document
 * still parses" has to be spelled out here. It rejects the shape a mis-placed
 * insertion produces: a line indented under a sibling that already carries a
 * complete value.
 */
function expectBlockYamlToParse(text: string): void {
  let openIndents: number[] = []
  let previous: { indent: number; opens: boolean } | null = null
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (trimmed === '---' || trimmed === '...') {
      openIndents = []
      previous = null
      continue
    }
    const indent = line.length - line.trimStart().length
    if (previous === null) {
      openIndents = [indent]
    } else if (indent > previous.indent) {
      if (!previous.opens) {
        throw new Error(`line ${index + 1}: indent ${indent} under a completed value at indent ${previous.indent} (${trimmed})`)
      }
      openIndents.push(indent)
    } else if (indent < previous.indent) {
      while (openIndents.length > 0 && openIndents[openIndents.length - 1]! > indent) openIndents.pop()
      if (openIndents[openIndents.length - 1] !== indent) {
        throw new Error(`line ${index + 1}: indent ${indent} matches no open block (${trimmed})`)
      }
    }
    previous = { indent, opens: opensBlock(trimmed) }
  }
}

describe('EvolutionService apply/rollback state machine', () => {
  it('walks decided(PROMOTE) → applied → rolledback and derives the full history', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await walkToDecided(svc, skillProposal, { name: 'verify', content: '# new verify skill\n' })
    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(applied.proposal.status).toBe('applied')
    expect(applied.proposal.applied).toEqual({ targets: [join(skillRoot, 'verify', 'SKILL.md')], approvalRef: 'approval:call-1' })
    const rolledback = await svc.rollback('s1', 'root-1', 'approval:call-2')
    expect(rolledback.proposal.status).toBe('rolledback')
    expect(rolledback.proposal.history.map(entry => entry.status)).toEqual([
      'proposed', 'candidate', 'prepared', 'replayed', 'gated', 'decided', 'applied', 'rolledback',
    ])
  })

  it.each(['REJECT', 'KEEP_FOR_FURTHER_RESEARCH'] as const)('refuses apply on a decided %s proposal', async decision => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: '# new\n' })
    await svc.prepare('s1', 'root-1')
    await svc.replay('s1', 'root-1', replayReport('s1', 'skill'))
    await svc.gate('s1', gateAnswers(['sandbox/s1/replay-report.json']), 'root-1')
    await svc.decide('s1', decision, 'root-1', 'approval:call-1')
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow(
      `cannot record "applied" — the recorded decision is ${decision}; only a PROMOTE decision can be applied`,
    )
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
  })

  it('refuses apply before the decision, a repeated apply, rollback before apply, and a repeated rollback', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: '# new\n' })
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
    await svc.prepare('s1', 'root-1')
    await svc.replay('s1', 'root-1', replayReport('s1', 'skill'))
    await svc.gate('s1', gateAnswers(['sandbox/s1/replay-report.json']), 'root-1')
    await expect(svc.rollback('s1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "rolledback"')
    await svc.decide('s1', 'PROMOTE', 'root-1', 'approval:call-1')
    await svc.apply('s1', 'root-1', 'approval:call-1')
    await expect(svc.apply('s1', 'root-1', 'approval:call-1')).rejects.toThrow('is applied; cannot record "applied"')
    await svc.rollback('s1', 'root-1', 'approval:call-2')
    await expect(svc.rollback('s1', 'root-1', 'approval:call-3')).rejects.toThrow('is rolledback; cannot record "rolledback"')
  })

  it('refuses apply for L4, task_definition, bookkeeping-only, and mutation-less proposals, pointing at the manual path', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await walkToDecided(svc, { ...skillProposal, proposalId: 's-l4', level: 'L4' }, { name: 'verify', content: '# new\n' })
    await expect(svc.apply('s-l4', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')

    await walkToDecided(svc, proposal, { baseVersion: 'v3', definition: { objective: 'x' } }, { taskDefinition: null })
    await expect(svc.apply('p1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')

    await svc.propose({ ...proposal, proposalId: 'v1', targetType: 'verifier', targetId: 'verifier:1' }, 'root-1')
    await svc.candidate('v1', VERSION_SET, 'root-1', { notes: 'tighten the verifier' })
    await svc.prepare('v1', 'root-1')
    const evidenceFile = join(svc.root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await svc.gate('v1', gateAnswers([evidenceFile]), 'root-1')
    await svc.decide('v1', 'PROMOTE', 'root-1', 'approval:call-1')
    await expect(svc.apply('v1', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')

    await svc.propose({ ...skillProposal, proposalId: 's-manual' }, 'root-1')
    await svc.candidate('s-manual', VERSION_SET, 'root-1')
    await svc.gate('s-manual', gateAnswers([evidenceFile]), 'root-1')
    await svc.decide('s-manual', 'PROMOTE', 'root-1', 'approval:call-1')
    await expect(svc.apply('s-manual', 'root-1', 'approval:call-1')).rejects.toThrow('cannot record "applied"')
  })

  it('replays a ledger with applied and rolledback records to the same fold after reopen', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await walkToDecided(svc, skillProposal, { name: 'verify', content: '# new verify skill\n' })
    await svc.apply('s1', 'root-1', 'approval:call-1')
    await svc.rollback('s1', 'root-1', 'approval:call-2')
    const reopened = new EvolutionService(fixtureCtx(), { root, skillRoot })
    const folded = await reopened.get('s1')
    expect(folded.status).toBe('rolledback')
    expect(folded.applied?.approvalRef).toBe('approval:call-1')
    expect(folded.rolledback?.approvalRef).toBe('approval:call-2')
    expect(folded.history).toHaveLength(8)
  })

  it('fails loudly on a forged applied record: wrong base state or a malformed payload', async () => {
    const { svc, root, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old\n')
    await svc.propose(skillProposal, 'root-1')
    await svc.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: '# new\n' })
    await svc.prepare('s1', 'root-1')
    await svc.replay('s1', 'root-1', replayReport('s1', 'skill'))
    await svc.gate('s1', gateAnswers(['sandbox/s1/replay-report.json']), 'root-1')
    await svc.decide('s1', 'REJECT', 'root-1', 'approval:call-1')
    const forged = { formatVersion: 1, kind: 'applied', proposalId: 's1', targets: ['/x'], approvalRef: 'approval:call-9', actor: 'x', at: 'now' }
    await writeFile(join(root, 'proposals.jsonl'), `${JSON.stringify(forged)}\n`, { flag: 'a' })
    const reopened = new EvolutionService(fixtureCtx(), { root, skillRoot })
    await expect(reopened.list()).rejects.toThrow('cannot record "applied"')

    const root2 = await mkdtemp(join(tmpdir(), 'evolution-'))
    const svc2 = new EvolutionService(fixtureCtx(), { root: root2 })
    await svc2.propose(skillProposal, 'root-1')
    await svc2.candidate('s1', VERSION_SET, 'root-1', { name: 'verify', content: '# new\n' })
    await svc2.prepare('s1', 'root-1')
    await svc2.replay('s1', 'root-1', replayReport('s1', 'skill'))
    await svc2.gate('s1', gateAnswers(['sandbox/s1/replay-report.json']), 'root-1')
    await svc2.decide('s1', 'PROMOTE', 'root-1', 'approval:call-1')
    const malformed = { formatVersion: 1, kind: 'applied', proposalId: 's1', targets: [], approvalRef: '', actor: 'x', at: 'now' }
    await writeFile(join(root2, 'proposals.jsonl'), `${JSON.stringify(malformed)}\n`, { flag: 'a' })
    const reopened2 = new EvolutionService(fixtureCtx(), { root: root2 })
    await expect(reopened2.list()).rejects.toThrow('malformed target list')
  })
})

describe('EvolutionService apply/rollback production writes', () => {
  it('applies a skill mutation over the production SKILL.md and rolls it back to the champion bytes', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await writeFile(join(skillRoot, 'verify', 'reference.md'), '# aux file the snapshot never captured\n')
    await walkToDecided(svc, skillProposal, { name: 'verify', content: '# new verify skill\n' })

    const applied = await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# new verify skill\n')
    // file-level semantics: auxiliary files the champion snapshot never captured stay put
    expect(await readFile(join(skillRoot, 'verify', 'reference.md'), 'utf8')).toBe('# aux file the snapshot never captured\n')
    expect(applied.targets).toEqual([join(skillRoot, 'verify', 'SKILL.md')])

    await svc.rollback('s1', 'root-1', 'approval:call-2')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
    expect(await readFile(join(skillRoot, 'verify', 'reference.md'), 'utf8')).toBe('# aux file the snapshot never captured\n')
  })

  it('creates a missing champion skill on apply and deletes the product on rollback', async () => {
    const { svc, skillRoot } = await serviceWithProduction()
    await walkToDecided(svc, skillProposal, { name: 'verify', content: '# new verify skill\n' })
    expect((await svc.get('s1')).prepared?.champion).toBe('missing')

    await svc.apply('s1', 'root-1', 'approval:call-1')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# new verify skill\n')

    const rolledback = await svc.rollback('s1', 'root-1', 'approval:call-2')
    expect(existsSync(join(skillRoot, 'verify'))).toBe(false)
    expect(rolledback.targets[0]).toContain('deleted')
  })

  it('replaces a production preset directory wholesale and restores the champion directory', async () => {
    const { svc, presetRoot } = await serviceWithProduction()
    await mkdir(join(presetRoot, 'bb-verify'), { recursive: true })
    await writeFile(join(presetRoot, 'bb-verify', 'agent.md'), 'old agent')
    await writeFile(join(presetRoot, 'bb-verify', 'extra.txt'), 'champion-only file')
    const mutation = { presetId: 'bb-verify', files: [{ path: 'agent.md', content: 'new agent' }, { path: 'added.md', content: 'added' }] }
    await walkToDecided(svc, presetProposal, mutation)

    await svc.apply('pr1', 'root-1', 'approval:call-1')
    expect(await readFile(join(presetRoot, 'bb-verify', 'agent.md'), 'utf8')).toBe('new agent')
    expect(await readFile(join(presetRoot, 'bb-verify', 'added.md'), 'utf8')).toBe('added')
    // whole-directory replacement: a champion-only file is gone while the candidate rules
    expect(existsSync(join(presetRoot, 'bb-verify', 'extra.txt'))).toBe(false)

    await svc.rollback('pr1', 'root-1', 'approval:call-2')
    expect(await readFile(join(presetRoot, 'bb-verify', 'agent.md'), 'utf8')).toBe('old agent')
    expect(await readFile(join(presetRoot, 'bb-verify', 'extra.txt'), 'utf8')).toBe('champion-only file')
    expect(existsSync(join(presetRoot, 'bb-verify', 'added.md'))).toBe(false)
  })

  it('creates a missing champion preset on apply and deletes the product on rollback', async () => {
    const { svc, presetRoot } = await serviceWithProduction()
    await walkToDecided(svc, presetProposal, { presetId: 'bb-verify', files: [{ path: 'agent.md', content: 'new agent' }] })

    await svc.apply('pr1', 'root-1', 'approval:call-1')
    expect(await readFile(join(presetRoot, 'bb-verify', 'agent.md'), 'utf8')).toBe('new agent')

    await svc.rollback('pr1', 'root-1', 'approval:call-2')
    expect(existsSync(join(presetRoot, 'bb-verify'))).toBe(false)
  })

  it('edits exactly one capability row in config.yml doc 1 and restores it byte-for-byte on rollback (sha256 round trip)', async () => {
    const { svc, configFile } = await serviceWithProduction()
    // The #18 scenario: the registry entry is schema-normalized (default arrays
    // filled) while the config.yml source row omits them — the rollback must
    // restore the source text, not re-render the entry.
    await walkToDecided(svc, capabilityProposal, capabilityMutation, { capabilityEntry: { skills: [], tools: [], preset: 'standard' } })
    expect((await svc.get('c1')).prepared?.championSource).toBe('config-text')
    const sha256Before = createHash('sha256').update(CONFIG_FIXTURE).digest('hex')

    const applied = await svc.apply('c1', 'root-1', 'approval:call-1')
    const afterApply = await readFile(configFile, 'utf8')
    expect(afterApply).toContain('      research: { skills: [verify], preset: standard }\n')
    expect(afterApply).not.toContain('      research: { preset: standard }\n')
    expect(doc2(afterApply)).toBe(doc2(CONFIG_FIXTURE))
    const beforeLines = CONFIG_FIXTURE.split('\n')
    const afterLines = afterApply.split('\n')
    expect(afterLines.length).toBe(beforeLines.length)
    expect(afterLines.filter((line, index) => line !== beforeLines[index])).toEqual(['      research: { skills: [verify], preset: standard }'])
    expect(applied.capability).toEqual({ name: 'research', entry: { preset: 'standard', skills: ['verify'] } })
    expect(createHash('sha256').update(afterApply).digest('hex')).not.toBe(sha256Before)

    const rolledback = await svc.rollback('c1', 'root-1', 'approval:call-2')
    const afterRollback = await readFile(configFile, 'utf8')
    expect(afterRollback).toBe(CONFIG_FIXTURE)
    expect(createHash('sha256').update(afterRollback).digest('hex')).toBe(sha256Before)
    expect(rolledback.capability).toEqual({ name: 'research', entry: { skills: [], tools: [], preset: 'standard' } })
  })

  it('marks a registry-only champion code-default and rolls back by removing the config.yml row', async () => {
    const { svc, root, configFile } = await serviceWithProduction()
    const codeOnlyProposal = { ...capabilityProposal, targetId: 'code-only' }
    await walkToDecided(svc, codeOnlyProposal, { name: 'code-only', entry: { skills: ['verify'] } }, { capabilityEntry: { preset: 'standard' } })
    const prepared = await svc.get('c1')
    expect(prepared.prepared?.champion).toBe('captured')
    expect(prepared.prepared?.championSource).toBe('code-default')
    expect(existsSync(join(root, 'sandbox', 'c1', 'champion', 'capability-table.source.txt'))).toBe(false)
    const sha256Before = createHash('sha256').update(await readFile(configFile, 'utf8')).digest('hex')

    const applied = await svc.apply('c1', 'root-1', 'approval:call-1')
    expect(await readFile(configFile, 'utf8')).toContain('      code-only: { skills: [verify] }\n')
    expect(applied.targets[0]).toContain('(added)')

    const rolledback = await svc.rollback('c1', 'root-1', 'approval:call-2')
    const afterRollback = await readFile(configFile, 'utf8')
    expect(afterRollback).toBe(CONFIG_FIXTURE)
    expect(createHash('sha256').update(afterRollback).digest('hex')).toBe(sha256Before)
    expect(rolledback.targets[0]).toContain('(removed)')
    // the code default governs again: the runtime override restores the champion entry, not null
    expect(rolledback.capability).toEqual({ name: 'code-only', entry: { preset: 'standard' } })
  })

  it('rolls back a pre-W19 record (no championSource, registry-form snapshot) exactly as before', async () => {
    const { svc, root, configFile } = await serviceWithProduction()
    await svc.propose(capabilityProposal, 'root-1')
    await svc.candidate('c1', VERSION_SET, 'root-1', capabilityMutation)
    // Forge the W16-era prepared record: registry-form champion, no championSource.
    await mkdir(join(root, 'sandbox', 'c1', 'champion'), { recursive: true })
    await writeFile(join(root, 'sandbox', 'c1', 'champion', 'capability-table.entry.yml'), '# champion\n{"research":{"skills":[],"tools":[],"preset":"standard"}}\n')
    await appendFile(
      join(root, 'proposals.jsonl'),
      `${JSON.stringify({ formatVersion: 1, kind: 'prepared', proposalId: 'c1', sandbox: 'sandbox/c1', mechanical: true, champion: 'captured', files: ['capability-table.patch.yml', 'champion/capability-table.entry.yml'], actor: 'root-1', at: new Date().toISOString() })}\n`,
    )
    const reopened = new EvolutionService(fixtureCtx(), { root, configFile })
    await reopened.replay('c1', 'root-1', replayReport('c1', 'capability'))
    await reopened.gate('c1', gateAnswers(['sandbox/c1/replay-report.json']), 'root-1')
    await reopened.decide('c1', 'PROMOTE', 'root-1', 'approval:call-0')
    await reopened.apply('c1', 'root-1', 'approval:call-1')
    const rolledback = await reopened.rollback('c1', 'root-1', 'approval:call-2')
    // legacy semantics: the registry-form entry is re-rendered (schema-normalized), not the source text
    expect(await readFile(configFile, 'utf8')).toContain('      research: { skills: [], tools: [], preset: standard }\n')
    expect(rolledback.capability).toEqual({ name: 'research', entry: { skills: [], tools: [], preset: 'standard' } })
  })

  it('adds a new capability row on apply and removes it on rollback, the rest of the file byte-identical', async () => {
    const { svc, configFile } = await serviceWithProduction()
    await walkToDecided(svc, capabilityProposal, { name: 'research-plus', entry: { skills: ['verify'], tools: ['web'] } }, { capabilityEntry: null })
    expect((await svc.get('c1')).prepared?.champion).toBe('missing')

    const applied = await svc.apply('c1', 'root-1', 'approval:call-1')
    const afterApply = await readFile(configFile, 'utf8')
    expect(afterApply).toContain('      research: { preset: standard }\n      research-plus: { skills: [verify], tools: [web] }\n')
    expect(doc2(afterApply)).toBe(doc2(CONFIG_FIXTURE))
    expect(applied.targets[0]).toContain('(added)')

    const rolledback = await svc.rollback('c1', 'root-1', 'approval:call-2')
    expect(await readFile(configFile, 'utf8')).toBe(CONFIG_FIXTURE)
    expect(rolledback.capability).toEqual({ name: 'research-plus', entry: null })
  })
})

describe('editCapabilityRow text surgery', () => {
  it('replaces a flow row, touching no other byte', () => {
    const result = editCapabilityRow(CONFIG_FIXTURE, 'research', { skills: ['verify'], preset: 'bb-verify' })
    expect(result.action).toBe('replaced')
    expect(result.text).toContain('      research: { skills: [verify], preset: bb-verify }\n')
    expect(doc2(result.text)).toBe(doc2(CONFIG_FIXTURE))
    const beforeLines = CONFIG_FIXTURE.split('\n')
    const afterLines = result.text.split('\n')
    expect(afterLines.length).toBe(beforeLines.length)
    expect(afterLines.filter((line, index) => line !== beforeLines[index])).toHaveLength(1)
  })

  it('adds a row after the last entry, at the sibling indent', () => {
    const result = editCapabilityRow(CONFIG_FIXTURE, 'new-cap', { tools: ['bash'] })
    expect(result.action).toBe('added')
    expect(result.text).toContain('      research: { preset: standard }\n      new-cap: { tools: [bash] }\n    defaultPreset: standard\n')
  })

  it('removes a row, and collapses the mapping header when the last row goes', () => {
    const removed = editCapabilityRow(CONFIG_FIXTURE, 'research', null)
    expect(removed.action).toBe('removed')
    expect(removed.text).not.toContain('research: { preset: standard }')
    expect(doc2(removed.text)).toBe(doc2(CONFIG_FIXTURE))
    const emptied = editCapabilityRow(removed.text, 'design-chip', null)
    expect(emptied.text).toContain('    capabilities: {}\n')
    expect(emptied.text).not.toContain('    capabilities:\n')
    expect(doc2(emptied.text)).toBe(doc2(CONFIG_FIXTURE))
  })

  it('replaces a block-form row span with one flow line', () => {
    const blockForm = CONFIG_FIXTURE.replace(
      '      research: { preset: standard }\n',
      '      research:\n        preset: standard\n        skills: [verify]\n',
    )
    const result = editCapabilityRow(blockForm, 'research', { preset: 'standard' })
    expect(result.action).toBe('replaced')
    expect(result.text).toContain('      research: { preset: standard }\n    defaultPreset: standard\n')
    expect(doc2(result.text)).toBe(doc2(CONFIG_FIXTURE))
  })

  it('adds after a block-form last entry, leaving that entry whole', () => {
    const blockForm = CONFIG_FIXTURE.replace(
      '      research: { preset: standard }\n',
      '      research:\n        preset: standard\n',
    )
    const result = editCapabilityRow(blockForm, 'new-cap', { tools: ['bash'] })
    expect(result.action).toBe('added')
    expect(result.text).toBe(
      blockForm.replace(
        '      research:\n        preset: standard\n',
        '      research:\n        preset: standard\n      new-cap: { tools: [bash] }\n',
      ),
    )
    expect(doc2(result.text)).toBe(doc2(CONFIG_FIXTURE))
    expectBlockYamlToParse(result.text)
  })

  it('adds after a block-form last entry whose body carries comments and a blank line', () => {
    const blockForm = CONFIG_FIXTURE.replace(
      '      research: { preset: standard }\n',
      '      research:\n        # why: no chip skill needed\n        preset: standard\n\n        tools: [bash]\n',
    )
    const result = editCapabilityRow(blockForm, 'new-cap', { tools: ['bash'] })
    expect(result.text).toBe(
      blockForm.replace('        tools: [bash]\n', '        tools: [bash]\n      new-cap: { tools: [bash] }\n'),
    )
    expectBlockYamlToParse(result.text)
  })

  it('removes a commented block-form row without leaving its body behind', () => {
    const blockForm = CONFIG_FIXTURE.replace(
      '      research: { preset: standard }\n',
      '      research:\n        # why: no chip skill needed\n        preset: standard\n\n        tools: [bash]\n',
    )
    const result = editCapabilityRow(blockForm, 'research', null)
    expect(result.action).toBe('removed')
    expect(result.text).toBe(CONFIG_FIXTURE.replace('      research: { preset: standard }\n', ''))
    expect(result.text).not.toContain('why: no chip skill needed')
    expectBlockYamlToParse(result.text)
  })

  it('collapses the header when a block-form row with a trailing comment was the only entry', () => {
    const onlyBlock = CONFIG_FIXTURE.replace(
      '      design-chip: { skills: [chip-designer] }\n      research: { preset: standard }\n',
      '      research:\n        preset: standard\n      # trailing note about research\n',
    )
    const result = editCapabilityRow(onlyBlock, 'research', null)
    expect(result.text).toBe(
      onlyBlock
        .replace('      research:\n        preset: standard\n      # trailing note about research\n', '')
        .replace('    capabilities:\n', '    capabilities: {}\n'),
    )
    expect(result.text).toContain('    capabilities: {}\n    defaultPreset: standard\n')
    expectBlockYamlToParse(result.text)
  })

  it('adds into a collapsed `capabilities: {}` mapping by reopening the header as a block', () => {
    const emptied = editCapabilityRow(
      editCapabilityRow(CONFIG_FIXTURE, 'research', null).text,
      'design-chip',
      null,
    ).text
    const result = editCapabilityRow(emptied, 'new-cap', { tools: ['bash'] })
    expect(result.action).toBe('added')
    expect(result.text).toBe(
      emptied.replace('    capabilities: {}\n', '    capabilities:\n      new-cap: { tools: [bash] }\n'),
    )
    expectBlockYamlToParse(result.text)
  })

  it('adds under a `capabilities:` header that carries only a comment', () => {
    const commented = CONFIG_FIXTURE.replace(
      '      design-chip: { skills: [chip-designer] }\n      research: { preset: standard }\n',
      '    # capability name → skills / tool labels / agent preset\n',
    )
    const result = editCapabilityRow(commented, 'new-cap', { tools: ['bash'] })
    expect(result.text).toBe(
      commented.replace(
        '    capabilities:\n    # capability name → skills / tool labels / agent preset\n',
        '    capabilities:\n    # capability name → skills / tool labels / agent preset\n      new-cap: { tools: [bash] }\n',
      ),
    )
    expectBlockYamlToParse(result.text)
  })

  it('preserves CRLF line endings', () => {
    const crlf = CONFIG_FIXTURE.replaceAll('\n', '\r\n')
    const result = editCapabilityRow(crlf, 'research', { preset: 'standard' })
    expect(result.text).toContain('      research: { preset: standard }\r\n')
    expect(doc2(result.text)).toBe(doc2(crlf))
    expect(result.text).not.toContain('research: { preset: standard }\n')
  })

  it('preserves CRLF when adding after a block-form last entry', () => {
    const blockForm = CONFIG_FIXTURE.replace(
      '      research: { preset: standard }\n',
      '      research:\n        preset: standard\n',
    ).replaceAll('\n', '\r\n')
    const result = editCapabilityRow(blockForm, 'new-cap', { tools: ['bash'] })
    expect(result.text).toBe(
      blockForm.replace(
        '      research:\r\n        preset: standard\r\n',
        '      research:\r\n        preset: standard\r\n      new-cap: { tools: [bash] }\r\n',
      ),
    )
    expect(result.text).not.toMatch(/[^\r]\n/)
    expectBlockYamlToParse(result.text)
  })

  it('quotes a non-plain key, and the quoted round trip removes exactly what it added', () => {
    const added = editCapabilityRow(CONFIG_FIXTURE, 'weird: name', { preset: 'standard' })
    expect(added.text).toContain('      "weird: name": { preset: standard }\n')
    const removed = editCapabilityRow(added.text, 'weird: name', null)
    expect(removed.text).toBe(CONFIG_FIXTURE)
  })

  it('throws — editing nothing — when the row to remove, the task-runtime entry, or the mapping is absent', () => {
    expect(() => editCapabilityRow(CONFIG_FIXTURE, 'ghost', null)).toThrow('no capabilities row for "ghost" to remove')
    expect(() => editCapabilityRow(CONFIG_FIXTURE.replace('- id: task-runtime', '- id: other'), 'research', { preset: 'x' }))
      .toThrow('no "- id: task-runtime" entry')
    expect(() => editCapabilityRow(CONFIG_FIXTURE.replace('    capabilities:\n', ''), 'research', { preset: 'x' }))
      .toThrow('no "capabilities:" mapping')
  })

  it('refuses to guess when the task-runtime entry appears more than once in document 1', () => {
    const duplicated = CONFIG_FIXTURE.replace(
      '\n---',
      '\n- id: task-runtime\n  config:\n    capabilities: {}\n\n---',
    )
    expect(() => editCapabilityRow(duplicated, 'research', { preset: 'x' }))
      .toThrow('document 1 has 2 "- id: task-runtime" entries (lines 8, 16)')
    // a same-named entry in document 2 is out of scope — only document 1 governs
    const inDoc2 = CONFIG_FIXTURE.replace('---\n', '---\n- id: task-runtime\n')
    expect(editCapabilityRow(inDoc2, 'research', { preset: 'x' }).action).toBe('replaced')
  })

  it('applies the same duplicate check to a single-document config', () => {
    const singleDoc = CONFIG_FIXTURE.slice(0, CONFIG_FIXTURE.indexOf('---'))
    expect(editCapabilityRow(singleDoc, 'research', { preset: 'x' }).action).toBe('replaced')
    const duplicated = `${singleDoc}- id: task-runtime\n  config: {}\n`
    expect(() => editCapabilityRow(duplicated, 'research', { preset: 'x' }))
      .toThrow('document 1 has 2 "- id: task-runtime" entries (lines 8, 16)')
  })
})

describe('capability row source capture and verbatim restore (W19)', () => {
  it('reads a flow row verbatim, and a block-form row with its riding comments', () => {
    expect(readCapabilityRowSource(CONFIG_FIXTURE, 'research')).toBe('      research: { preset: standard }')
    const blockForm = CONFIG_FIXTURE.replace(
      '      research: { preset: standard }\n',
      '      research:\n        # why: no chip skill needed\n        preset: standard\n        tools: [bash]\n',
    )
    expect(readCapabilityRowSource(blockForm, 'research')).toBe(
      '      research:\n        # why: no chip skill needed\n        preset: standard\n        tools: [bash]',
    )
    expect(readCapabilityRowSource(CONFIG_FIXTURE, 'ghost')).toBeNull()
  })

  it('restores the source lines byte-for-byte over an applied row', () => {
    const source = readCapabilityRowSource(CONFIG_FIXTURE, 'research')!
    const applied = editCapabilityRow(CONFIG_FIXTURE, 'research', { skills: ['verify'], preset: 'standard' })
    const restored = restoreCapabilityRowSource(applied.text, 'research', source)
    expect(restored.action).toBe('replaced')
    expect(restored.text).toBe(CONFIG_FIXTURE)
  })

  it('restores a block-form source span over the flow row an apply wrote', () => {
    const blockForm = CONFIG_FIXTURE.replace(
      '      research: { preset: standard }\n',
      '      research:\n        preset: standard\n        skills: [verify]\n',
    )
    const source = readCapabilityRowSource(blockForm, 'research')!
    const applied = editCapabilityRow(blockForm, 'research', { preset: 'bb-verify' })
    expect(applied.text).toContain('      research: { preset: bb-verify }\n')
    const restored = restoreCapabilityRowSource(applied.text, 'research', source)
    expect(restored.text).toBe(blockForm)
    expectBlockYamlToParse(restored.text)
  })

  it('inserts the source lines when the row is gone at rollback time', () => {
    const source = readCapabilityRowSource(CONFIG_FIXTURE, 'research')!
    const removed = editCapabilityRow(CONFIG_FIXTURE, 'research', null)
    const restored = restoreCapabilityRowSource(removed.text, 'research', source)
    expect(restored.action).toBe('added')
    expect(restored.text).toBe(CONFIG_FIXTURE)
  })

  it('round-trips byte-identically under CRLF line endings', () => {
    const crlf = CONFIG_FIXTURE.replaceAll('\n', '\r\n')
    const source = readCapabilityRowSource(crlf, 'research')!
    expect(source).not.toContain('\r')
    const applied = editCapabilityRow(crlf, 'research', { skills: ['verify'], preset: 'standard' })
    expect(restoreCapabilityRowSource(applied.text, 'research', source).text).toBe(crlf)
  })
})

describe('evolution_apply / evolution_rollback tools', () => {
  /** toolCtx on top of a production-fixture service (capability champion resolves from the taskRuntime mock). */
  async function toolCtxWithProduction(approvalOutcome: string = 'allowed-once') {
    const production = await serviceWithProduction()
    const { ctx, approval } = toolCtx(production.svc, approvalOutcome)
    return { ...production, ctx, approval }
  }

  it('applies and rolls back a skill through both human approvals, with the targets named in the reason and the record', async () => {
    const { svc, ctx, approval, skillRoot } = await toolCtxWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await walkToDecided(svc, skillProposal, { name: 'verify', content: '# new verify skill\n' })

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
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# new verify skill\n')

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
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
    expect((await svc.get('s1')).status).toBe('rolledback')
  })

  it.each(['rejected', 'cancelled', 'unavailable'])(
    'evolution_apply writes nothing when the approval comes back %s',
    async outcome => {
      const { svc, ctx, skillRoot } = await toolCtxWithProduction(outcome)
      await mkdir(join(skillRoot, 'verify'), { recursive: true })
      await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
      await walkToDecided(svc, skillProposal, { name: 'verify', content: '# new verify skill\n' })
      const result = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
      expect(result).toContain('nothing written')
      expect(result).toContain('stays decided')
      expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old verify skill\n')
      expect((await svc.get('s1')).status).toBe('decided')
      const ledger = (await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).trim().split('\n')
      expect(ledger.map(line => (JSON.parse(line) as { kind: string }).kind)).not.toContain('applied')
    },
  )

  it('evolution_rollback writes nothing when the human rejects it', async () => {
    const { svc, ctx, approval, skillRoot } = await toolCtxWithProduction('allowed-once')
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old verify skill\n')
    await walkToDecided(svc, skillProposal, { name: 'verify', content: '# new verify skill\n' })
    await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    approval.request.mockResolvedValue('rejected')
    const result = (await defineEvolutionRollbackTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))) as string
    expect(result).toContain('nothing written')
    expect(result).toContain('stays applied')
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# new verify skill\n')
    expect((await svc.get('s1')).status).toBe('applied')
  })

  it('refuses without asking the human: non-decided, non-PROMOTE, L4, task_definition, bookkeeping-only, mutation-less', async () => {
    const { svc, ctx, approval, skillRoot } = await toolCtxWithProduction()
    await mkdir(join(skillRoot, 'verify'), { recursive: true })
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old\n')
    const applyTool = defineEvolutionApplyTool(ctx)

    await svc.propose(skillProposal, 'root-1')
    expect((await applyTool.execute({ proposalId: 's1' }, exec('root-1'))) as string)
      .toContain('proposal s1 is proposed; only a decided proposal can be applied')

    await walkToDecided(svc, { ...skillProposal, proposalId: 's-l4', level: 'L4' }, { name: 'verify', content: '# new\n' })
    expect((await applyTool.execute({ proposalId: 's-l4' }, exec('root-1'))) as string)
      .toContain('L4 harness evolution is human-run by rule')

    await walkToDecided(svc, proposal, { baseVersion: 'v3', definition: { objective: 'x' } }, { taskDefinition: null })
    expect((await applyTool.execute({ proposalId: 'p1' }, exec('root-1'))) as string)
      .toContain('task_definition has no production registry to write')

    await svc.propose({ ...proposal, proposalId: 'v1', targetType: 'verifier', targetId: 'verifier:1' }, 'root-1')
    await svc.candidate('v1', VERSION_SET, 'root-1', { notes: 'tighten the verifier' })
    await svc.prepare('v1', 'root-1')
    const evidenceFile = join(svc.root, 'regression.log')
    await writeFile(evidenceFile, 'ok')
    await svc.gate('v1', gateAnswers([evidenceFile]), 'root-1')
    await svc.decide('v1', 'PROMOTE', 'root-1', 'approval:call-1')
    expect((await applyTool.execute({ proposalId: 'v1' }, exec('root-1'))) as string)
      .toContain('bookkeeping-only (mechanical: false)')

    await svc.propose({ ...skillProposal, proposalId: 's-manual' }, 'root-1')
    await svc.candidate('s-manual', VERSION_SET, 'root-1')
    await svc.gate('s-manual', gateAnswers([evidenceFile]), 'root-1')
    await svc.decide('s-manual', 'PROMOTE', 'root-1', 'approval:call-1')
    expect((await applyTool.execute({ proposalId: 's-manual' }, exec('root-1'))) as string)
      .toContain('nothing was materialized')

    await svc.propose({ ...skillProposal, proposalId: 's-rej' }, 'root-1')
    await svc.candidate('s-rej', VERSION_SET, 'root-1', { name: 'verify', content: '# new\n' })
    await svc.prepare('s-rej', 'root-1')
    await svc.replay('s-rej', 'root-1', replayReport('s-rej', 'skill'))
    await svc.gate('s-rej', gateAnswers(['sandbox/s-rej/replay-report.json']), 'root-1')
    await svc.decide('s-rej', 'REJECT', 'root-1', 'approval:call-1')
    expect((await applyTool.execute({ proposalId: 's-rej' }, exec('root-1'))) as string)
      .toContain('was decided REJECT; only a PROMOTE decision can be applied')

    expect(approval.request).not.toHaveBeenCalled()
    expect(await readFile(join(skillRoot, 'verify', 'SKILL.md'), 'utf8')).toBe('# old\n')
  })

  it('mirrors a capability apply/rollback into the runtime registry and states the effect timing', async () => {
    const { svc, ctx, configFile } = await toolCtxWithProduction()
    await walkToDecided(svc, capabilityProposal, capabilityMutation, { capabilityEntry: { preset: 'standard' } })

    const applied = (await defineEvolutionApplyTool(ctx).execute({ proposalId: 'c1' }, exec('root-1'))) as string
    expect(applied).toContain('proposal c1 [applied] L2 capability research — PROMOTE in effect')
    expect(applied).toContain('runtime registry row replaced')
    expect(applied).toContain('effective immediately for admissions in this process')
    const taskRuntime = ctx as unknown as { taskRuntime: { applyCapabilityRow: ReturnType<typeof vi.fn> } }
    expect(taskRuntime.taskRuntime.applyCapabilityRow).toHaveBeenCalledExactlyOnceWith('research', { preset: 'standard', skills: ['verify'] })
    expect(await readFile(configFile, 'utf8')).toContain('      research: { skills: [verify], preset: standard }\n')

    const rolledback = (await defineEvolutionRollbackTool(ctx).execute({ proposalId: 'c1' }, exec('root-1'))) as string
    expect(rolledback).toContain('runtime registry row restored')
    expect(taskRuntime.taskRuntime.applyCapabilityRow).toHaveBeenCalledTimes(2)
    expect(taskRuntime.taskRuntime.applyCapabilityRow).toHaveBeenLastCalledWith('research', { preset: 'standard' })
    expect(await readFile(configFile, 'utf8')).toBe(CONFIG_FIXTURE)
  })

  it('rolls back a champion-missing capability by removing the row, runtime included', async () => {
    const { svc, ctx, configFile } = await toolCtxWithProduction()
    await walkToDecided(svc, capabilityProposal, { name: 'research-plus', entry: { skills: ['verify'] } }, { capabilityEntry: null })
    await defineEvolutionApplyTool(ctx).execute({ proposalId: 'c1' }, exec('root-1'))
    expect(await readFile(configFile, 'utf8')).toContain('      research-plus: { skills: [verify] }\n')

    const result = (await defineEvolutionRollbackTool(ctx).execute({ proposalId: 'c1' }, exec('root-1'))) as string
    expect(result).toContain('runtime registry row removed')
    const taskRuntime = ctx as unknown as { taskRuntime: { applyCapabilityRow: ReturnType<typeof vi.fn> } }
    expect(taskRuntime.taskRuntime.applyCapabilityRow).toHaveBeenLastCalledWith('research-plus', null)
    expect(await readFile(configFile, 'utf8')).toBe(CONFIG_FIXTURE)
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
    await writeFile(join(skillRoot, 'verify', 'SKILL.md'), '# old\n')
    await walkToDecided(svc, skillProposal, { name: 'verify', content: '# new\n' })
    await defineEvolutionApplyTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    await defineEvolutionRollbackTool(ctx).execute({ proposalId: 's1' }, exec('root-1'))
    const listed = (await defineEvolutionListTool(ctx).execute({ status: 'rolledback' })) as string
    expect(listed).toContain('- s1 [rolledback PROMOTE] L2 skill verify (base v1)')
    expect(listed).toContain(`applied: [${join(skillRoot, 'verify', 'SKILL.md')}] (approval approval:call-1)`)
    expect(listed).toContain('rolled back:')
    expect(listed).toContain('history: proposed by root-1')
  })
})

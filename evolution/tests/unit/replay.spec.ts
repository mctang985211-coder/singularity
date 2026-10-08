import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ReplayTaskOptions } from '@dangosys/dsh-singularity-task-runtime'
import { EvolutionService } from '../../src/evolution.ts'
import { defineEvolutionProposeTool } from '../../../agent-singularity/src/tools/evolution-propose.ts'
import { defineEvolutionReplayTool } from '../../../agent-singularity/src/tools/evolution-replay.ts'
import { compareReplaySides } from '../../src/replay.ts'
import {
  graph,
  championTask,
  championReview,
  service,
  exec,
  capabilityProposal,
  preparedSkillExperiment,
  PRODUCTION_V1,
  FIXTURE_SELECTION,
  refusalOf,
} from './evolution.fixture.ts'

/**
 * The recursive content digest of a directory holding exactly `entries`, as the
 * experiment defines its input snapshot: `<relative path>\0<sha256>` lines,
 * sorted by path, hashed together. Computed here, so the frozen identity is
 * never confirmed against the implementation that produced it.
 */
function snapshotDigest(entries: Record<string, string>): string {
  const lines = Object.entries(entries)
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([rel, bytes]) => `${rel}\0${createHash('sha256').update(bytes).digest('hex')}`)
  return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')
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
        diagnoses: [],
        obligations: [],
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

describe('replay comparison', () => {
  const base = {
    taskId: 't1',
    outcome: 'verified' as const,
    criteria: [{ criterionId: 'ac1', verdict: 'pass' as const }],
  }

  it('matching sides compare not-worse with verdictMatch', () => {
    const result = compareReplaySides(base, { ...base })
    expect(result).toEqual({ verdictMatch: true, criteriaDiff: [], relation: 'not-worse' })
  })

  it('a failed candidate against a verified champion is worse', () => {
    const result = compareReplaySides(base, {
      ...base,
      outcome: 'failed',
      criteria: [{ criterionId: 'ac1', verdict: 'fail' }],
    })
    expect(result.relation).toBe('worse')
    expect(result.verdictMatch).toBe(false)
    expect(result.criteriaDiff).toEqual([{ criterionId: 'ac1', champion: 'pass', candidate: 'fail' }])
  })

  it('a shared criterion flipping pass → fail is a regression even when the outcome holds', () => {
    const result = compareReplaySides(
      {
        ...base,
        criteria: [
          { criterionId: 'ac1', verdict: 'pass' },
          { criterionId: 'ac2', verdict: 'fail' },
        ],
      },
      {
        ...base,
        outcome: 'failed',
        criteria: [
          { criterionId: 'ac1', verdict: 'fail' },
          { criterionId: 'ac2', verdict: 'fail' },
        ],
      },
    )
    // failed vs failed ranks equal, but ac1 flipped pass → fail
    expect(result.relation).toBe('worse')
  })

  it('a candidate fixing a failed champion is not-worse', () => {
    const champion = {
      taskId: 't1',
      outcome: 'failed' as const,
      criteria: [{ criterionId: 'ac1', verdict: 'fail' as const }],
    }
    const result = compareReplaySides(champion, {
      taskId: 't1',
      outcome: 'verified',
      criteria: [{ criterionId: 'ac1', verdict: 'pass' }],
    })
    expect(result.relation).toBe('not-worse')
    expect(result.verdictMatch).toBe(false)
  })

  it('an added criterion makes the contract comparison inconclusive', () => {
    const result = compareReplaySides(base, {
      ...base,
      criteria: [
        { criterionId: 'ac1', verdict: 'pass' },
        { criterionId: 'ac2', verdict: 'pass' },
      ],
    })
    expect(result.relation).toBe('inconclusive')
    expect(result.verdictMatch).toBe(false)
    expect(result.criteriaDiff).toEqual([{ criterionId: 'ac2', candidate: 'pass' }])
  })

  it('a cancelled candidate run is inconclusive, not worse', () => {
    const result = compareReplaySides(base, { ...base, outcome: 'cancelled' as const })
    expect(result.relation).toBe('inconclusive')
  })
})

describe('evolution_replay tool', () => {
  it('rejects an unknown proposal, running nothing', async () => {
    const svc = await service()
    const replayTask = vi.fn(async () => ({ ...replayOutcome }))
    const { ctx } = replayToolCtx(svc, replayTask)
    const tool = defineEvolutionReplayTool(ctx)
    const missing = (await tool.execute({ proposalId: 'ghost', taskIds: ['t-champ'] }, exec('root-1'))) as string
    expect(missing).toContain('unknown proposal "ghost"')
    expect(replayTask).not.toHaveBeenCalled()
  })

  it('refuses a capability proposal that was never prepared: no run, no sandbox and no ledger write', async () => {
    const svc = await service()
    const replayTask = vi.fn(async () => ({ ...replayOutcome }))
    const { ctx } = replayToolCtx(svc, replayTask)
    const tool = defineEvolutionReplayTool(ctx)
    await defineEvolutionProposeTool(ctx).execute({ ...capabilityProposal }, exec('root-1'))
    const before = await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')

    // A capability candidate is evaluable here since A6 — and only once it is
    // prepared, because the two-sided experiment mounts the row and the new skill
    // prepare froze. An unprepared proposal never reaches a run.
    const refused = (await tool.execute(
      { proposalId: 'c1', taskIds: ['t-champ'], holdoutTaskIds: ['t-holdout'] },
      exec('root-1'),
    )) as string
    expect(refused).toContain('evolution_replay rejected:')
    // The capability target type is no longer what this tool refuses: what it
    // refuses here is the sample derivation, which happens before anything is
    // read from the ledger — the fixture store holds no failed case to reproduce.
    expect(refused).toMatch(/at least one observed-failure/)
    expect(refused).not.toMatch(/prepared skill object candidate only/)
    expect(replayTask).not.toHaveBeenCalled()
    expect(existsSync(join(svc.root, 'sandbox'))).toBe(false)
    expect(await readFile(join(svc.root, 'proposals.jsonl'), 'utf8')).toBe(before)
    expect((await svc.get('c1')).status).toBe('proposed')
  })

  it('walks a skill candidate through the two-sided experiment: four sides, the sandbox overlay only on the candidate side', async () => {
    const { svc, root, replayTask, replayTool, experiment } = await preparedSkillExperiment()
    const result = (await replayTool.execute(
      {
        proposalId: 's1',
        taskIds: ['t-fail'],
        holdoutTaskIds: ['t-holdout'],
        budget: { maxTokens: 5_000, note: 'the fixture budget' },
      },
      exec('root-1'),
    )) as string

    // The answer renders the experiment: both sides of every sample, and the
    // baseline named as this experiment's own new run.
    expect(result).toContain('proposal s1 [experiment] skill verify — verdict: fixed')
    expect(result).toContain(
      't-fail [observed-failure] baseline failed → candidate verified (ac-fix fail→pass) — fixed',
    )
    expect(result).toContain(
      't-holdout [holdout] baseline verified → candidate verified (no criterion diff) — maintained',
    )
    expect(result).toContain('report: sandbox/s1/exp-')
    expect(result).not.toContain('champion')

    // Four runs: every sample twice, the baseline under the production
    // configuration and the candidate under the sandbox's skills dir.
    expect(replayTask).toHaveBeenCalledTimes(4)
    // The four sides as a set: the runner dispatches them through a worker pool,
    // so the order the mock observes them in is not fixed.
    const sides = replayTask.mock.calls
      .map(call => [call[1], call[2].overlay === undefined ? 'baseline' : 'candidate'])
      .sort()
    expect(sides).toEqual(
      [
        ['t-fail', 'baseline'],
        ['t-fail', 'candidate'],
        ['t-holdout', 'baseline'],
        ['t-holdout', 'candidate'],
      ].sort(),
    )
    for (const [storeId, _sample, options, caller] of replayTask.mock.calls.map(
      call => call as unknown as [string, string, ReplayTaskOptions, string],
    )) {
      expect(storeId).toBe('sg-t-root-1')
      expect(caller).toBe('root-1')
      expect(options.workspace?.path).toContain(join('sandbox', 's1'))
      expect(options.lineage).toContain('evolution-experiment:')
    }
    for (const call of replayTask.mock.calls.filter(call => call[2].overlay !== undefined)) {
      expect(call[2].overlay).toEqual({ extraSkillRoots: [join(root, 'sandbox', 's1', 'skills')] })
    }

    // The frozen block binds what ran: the candidate bytes, the production
    // baseline, the roles, the snapshot both workspaces were built from, the
    // structured model selection and the budget the call named.
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
    expect(
      started.frozen.samples.map((sample: { taskId: string; role: string }) => [sample.taskId, sample.role]),
    ).toEqual([
      ['t-fail', 'observed-failure'],
      ['t-holdout', 'holdout'],
    ])
    expect(started.frozen.snapshot.sourceDir).toBe(experiment.workspace)
    expect(started.frozen.snapshot.digest).toBe(snapshotDigest({ 'input.txt': 'the frozen input\n' }))
    expect(started.frozen.model).toEqual(FIXTURE_SELECTION)
    expect(started.frozen.budget).toEqual({ maxTokens: 5_000, note: 'the fixture budget' })
    expect(started.frozen.overlay.baseline).toContain('none')
    // The candidate's line names the complete object the sandbox root is loaded
    // from (K3), never a bare root a reader could mistake for one file.
    expect(started.frozen.overlay.candidate).toBe(
      'extraSkillRoots: [sandbox/s1/skills] — the complete candidate object: the guidance object "verify" (SKILL.md and frozen resources, no sidecar), ' +
        "loaded whole through the runtime's own discovery",
    )
    expect(lines.filter(line => line.kind === 'experiment_sample')).toHaveLength(4)

    // The proposal lifecycle does not move: a skill experiment is evidence, and
    // what may be promoted from it is the promotion gate's question.
    expect((await svc.get('s1')).status).toBe('prepared')
  })

  it('refuses the removed experiment wall clock at the service and at the tool, before any write or run', async () => {
    const { svc, root, replayTask, replayTool, workspace } = await preparedSkillExperiment()
    const ledgerBefore = await readFile(join(root, 'proposals.jsonl'), 'utf8')

    // A direct service call carries the removed field: the freeze refuses it by
    // name rather than running the experiment without the window it named.
    const message = await refusalOf(
      svc.runExperiment(
        {
          proposalId: 's1',
          samples: [
            { taskId: 't-fail', role: 'observed-failure' },
            { taskId: 't-holdout', role: 'holdout' },
          ],
          snapshot: { sourceDir: workspace },
          model: FIXTURE_SELECTION,
          budget: { wallTimeMs: 60_000 } as never,
          repetition: 0,
        },
        'root-1' as never,
        'root-1',
      ),
    )
    expect(message).toContain('wallTimeMs')
    expect(message).toMatch(/removed/)

    // The model's own entry refuses it at the schema boundary — the field is no
    // longer declared, so the call never reaches the service — and neither call
    // left a ledger line or started a run.
    const answer = await refusalOf(
      replayTool.execute(
        {
          proposalId: 's1',
          taskIds: ['t-fail'],
          holdoutTaskIds: ['t-holdout'],
          budget: { wallTimeMs: 60_000 },
        },
        exec('root-1'),
      ),
    )
    expect(answer).toContain('budget.wallTimeMs')
    expect(answer).toContain('not a declared property')
    expect(replayTask).not.toHaveBeenCalled()
    expect(await readFile(join(root, 'proposals.jsonl'), 'utf8')).toBe(ledgerBefore)
  })

  it('reuses every settled side when the same skill call is repeated: no run, no new ledger line', async () => {
    const { root, replayTask, replayTool, experiment } = await preparedSkillExperiment()
    const first = (await replayTool.execute(
      { proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] },
      exec('root-1'),
    )) as string
    expect(replayTask).toHaveBeenCalledTimes(4)

    const second = (await replayTool.execute(
      { proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'] },
      exec('root-1'),
    )) as string
    expect(second).toBe(first)
    expect(replayTask).toHaveBeenCalledTimes(4)
    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string })
    expect(lines.filter(line => line.kind === 'experiment_started')).toHaveLength(1)
    expect(lines.filter(line => line.kind === 'experiment_sample')).toHaveLength(4)

    // A higher repetition is the explicit new experiment §F.2 allows: four new
    // sides under its own frozen block.
    const third = (await replayTool.execute(
      { proposalId: 's1', taskIds: ['t-fail'], holdoutTaskIds: ['t-holdout'], repetition: 1 },
      exec('root-1'),
    )) as string
    expect(third).not.toBe(first)
    expect(third).toContain('repetition 1')
    expect(replayTask).toHaveBeenCalledTimes(8)
    expect(experiment.identity.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('refuses a skill call with no failed sample or with an empty holdout, running nothing', async () => {
    const { root, replayTask, replayTool } = await preparedSkillExperiment()
    const noFailure = (await replayTool.execute(
      { proposalId: 's1', taskIds: ['t-regression'], holdoutTaskIds: ['t-holdout'] },
      exec('root-1'),
    )) as string
    expect(noFailure).toContain('evolution_replay rejected:')
    expect(noFailure).toContain('at least one observed-failure')

    const noHoldout = (await replayTool.execute({ proposalId: 's1', taskIds: ['t-fail'] }, exec('root-1'))) as string
    expect(noHoldout).toContain('holdoutTaskIds must name at least one task that did not select this candidate')

    expect(replayTask).not.toHaveBeenCalled()
    const lines = (await readFile(join(root, 'proposals.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { kind: string })
    expect(lines.map(line => line.kind)).toEqual(['proposed', 'candidate', 'prepared'])
  })
})

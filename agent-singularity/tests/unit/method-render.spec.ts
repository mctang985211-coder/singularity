/**
 * The one rendering point: the publication approval's line order and content, the
 * difference and its truncation, and what an unknown cost reads as.
 */
import { describe, expect, it } from 'vitest'
import type { Admission, EvaluationReport, MethodDraft, TrialComparison } from '@dangosys/dsh-singularity-evolution'
import {
  renderAdmission,
  renderDiff,
  renderEvaluation,
  renderPublishReason,
  renderVersionSwitch,
} from '../../src/tools/method-render.ts'

const baselineRevision = { revisionId: 'r0001', digest: 'a'.repeat(64), libraryId: 'g1' }
const candidateRevision = { revisionId: 'c-d0001', digest: 'b'.repeat(64), libraryId: 'g1' }

function report(overrides: { readonly cost: 'reported' | 'unknown' } = { cost: 'reported' }): EvaluationReport {
  const trial = (side: 'baseline' | 'candidate'): TrialComparison['baseline'] => ({
    sampleTaskId: 't1',
    side,
    role: 'observed-failure',
    outcome: side === 'candidate' ? 'verified' : 'failed',
    receipt: {
      receiptId: `rc-${side}`,
      digest: side === 'baseline' ? 'c'.repeat(64) : 'd'.repeat(64),
      runId: `r-${side}`,
      criteria: [],
      evidenceRefs: [],
      cost: overrides.cost === 'unknown' ? { status: 'unknown', reason: 'no sealed receipt reports tokens' } : { status: 'reported', tokens: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      boundRevision: side === 'baseline' ? 'r0001' : 'c-d0001',
      boundModel: 'p/m',
      workspace: `/tmp/${side}`,
      workspaceDigest: 'e'.repeat(64),
      complete: true,
    },
    actor: 's-supervisor',
    at: '2026-10-08T00:00:00.000Z',
  })
  const comparison: TrialComparison = { sampleTaskId: 't1', role: 'observed-failure', baseline: trial('baseline'), candidate: trial('candidate'), verdict: 'fixed' }
  return {
    formatVersion: 5,
    draftId: 'd0001',
    evaluationId: 'e-1',
    planId: 'p-1',
    libraryId: 'g1',
    kind: 'skill',
    at: '2026-10-08T00:00:00.000Z',
    plan: {
      planId: 'p-1',
      draftId: 'd0001',
      kind: 'skill',
      libraryId: 'g1',
      sides: {
        baseline: { side: 'baseline', revision: baselineRevision, capabilities: [], registryRevision: 'reg-1', mcpServers: [], preset: null, skills: [], model: { provider: 'p', model: 'm', label: 'p/m' }, acceptance: [] },
        candidate: { side: 'candidate', revision: candidateRevision, capabilities: [], registryRevision: 'reg-2', mcpServers: [], preset: null, skills: [], model: { provider: 'p', model: 'm', label: 'p/m' }, acceptance: [] },
      },
      samples: [],
      input: { sourceDir: '/tmp/in', digest: 'f'.repeat(64) },
      rules: { quality: { metricId: 'acceptance', direction: 'higher-is-better', extractor: 'acceptance' }, guards: [] },
      budget: {},
      repetition: 2,
      overlay: { baseline: 'a', candidate: 'b' },
      strategy: { policy: { version: 'rrsi-strategy@1' } as never, policyDigest: '0'.repeat(64), cohortDigest: '1'.repeat(64) },
      schemaVersion: 'evaluation-plan@1',
    },
    planDigest: '2'.repeat(64),
    trials: [comparison],
    score: {
      quality: { baseline: 0.2, candidate: 0.8, delta: 0.6, unit: 'acceptance-success-rate' },
      cost: overrides.cost === 'unknown' ? { status: 'unknown', reason: 'no sealed receipt reports tokens' } : { status: 'reported', baselineTokens: 150, candidateTokens: 140, relativeDelta: -0.0667 },
      uncertainty: { basis: 'repeated-trials', repeats: 3, noiseBand: 0.02 },
      inconclusive: overrides.cost === 'unknown',
    },
    guards: [{ id: 'skill-consumed', kind: 'domain', ok: true, detail: 'the candidate side loaded the skill' }],
    verdict: 'fixed',
  } as EvaluationReport
}

const draft: MethodDraft = {
  draftId: 'd0001',
  kind: 'skill',
  identity: 'verify',
  baseRevision: baselineRevision,
  candidateRevision: { revisionId: 'c-d0001', digest: 'b'.repeat(64), files: [] },
  rationale: 'the observed failure is a missing check',
  sourceRefs: ['diagnosis:d1'],
  actor: 's-supervisor',
  at: '2026-10-08T00:00:00.000Z',
}

const admission: Admission = {
  candidateId: 'd0001',
  admissible: true,
  reasonCode: 'admissible',
  reason: 'admissible: gain 0.6000 > band 0.0200; cost change -0.067 <= budget 0.250',
  quality: 0.8,
  cost: 140,
  deltaQuality: 0.6,
  deltaCost: -0.0667,
  novelty: 0,
  bundleLevel: false,
  guards: [],
}

const calibration = { qualityBand: 0.02, relativeCostBand: 0.05, method: 'repeated-baseline-evaluations' as const, evaluations: 3, standardError: 0.01, degenerate: false }

describe('renderDiff', () => {
  it('shows every changed file with its own counts and digest', () => {
    const lines = renderDiff({
      from: 'r0001',
      to: 'c-d0001',
      digest: '9'.repeat(64),
      files: [
        { path: 'skills/verify/SKILL.md', change: 'updated', unified: [' unchanged', '-old body', '+new body'], sha256: 'a'.repeat(64) },
        { path: 'skills/extra/SKILL.md', change: 'added', unified: ['+a whole new file'], sha256: 'b'.repeat(64) },
      ],
    })
    expect(lines[0]).toBe(`asset diff (2 files, diff ${'9'.repeat(64)}):`)
    expect(lines[1]).toBe('  from r0001 → c-d0001')
    expect(lines[2]).toContain('--- skills/verify/SKILL.md (updated, +1/-1, sha256:aaaaaaaaaaaa)')
    expect(lines[3]).toBe('   unchanged')
    expect(lines[4]).toBe('  -old body')
    expect(lines[5]).toBe('  +new body')
    expect(lines[6]).toContain('--- skills/extra/SKILL.md (added, +1/-0')
  })

  it('truncates by file and by line, naming the ceiling and the diff digest a human can re-read', () => {
    const lines = renderDiff(
      {
        from: 'r0001',
        to: 'c-d0001',
        digest: '7'.repeat(64),
        files: [
          { path: 'a', change: 'updated', unified: Array.from({ length: 20 }, (_v, index) => `+line ${index}`), sha256: 'a'.repeat(64) },
          { path: 'b', change: 'added', unified: ['+b'], sha256: 'b'.repeat(64) },
        ],
      },
      { maxFiles: 1, maxLinesPerFile: 4 },
    )
    expect(lines).toContain(`  … 16 more lines (diff ${'7'.repeat(64)})`)
    expect(lines).toContain(`  … 1 more files (diff ${'7'.repeat(64)})`)
  })
})

describe('renderEvaluation', () => {
  it('shows both sides of every sample, the score, the guards and the cost status', () => {
    const text = renderEvaluation(report()).join('\n')
    expect(text).toContain('evaluation e-1 (report 222222222222, verdict fixed, repetition 3)')
    expect(text).toContain('t1 [observed-failure] baseline failed (150 tokens) → candidate verified (150 tokens) — fixed')
    expect(text).toContain('quality: baseline 0.2000 → candidate 0.8000 (delta +0.6000 acceptance-success-rate)')
    expect(text).toContain('cost: status reported, baseline 150 → candidate 140 tokens')
    expect(text).toContain('guards (non-compensatory): skill-consumed held')
    expect(text).toContain('inconclusive: no')
  })

  it('reads an unknown cost as inconclusive rather than as zero', () => {
    const text = renderEvaluation(report({ cost: 'unknown' })).join('\n')
    expect(text).toContain('cost: status unknown (no sealed receipt reports tokens) — an unknown cost is inconclusive, never a zero')
    expect(text).toContain('inconclusive: yes')
  })
})

describe('renderPublishReason', () => {
  it('states the candidate, the exact version switch, the difference, the evaluation, the admission and the rollback target in one place', () => {
    const reason = renderPublishReason({
      draft,
      report: report(),
      admission,
      calibration,
      diff: renderDiff({ from: 'r0001', to: 'c-d0001', digest: '9'.repeat(64), files: [{ path: 'skills/verify/SKILL.md', change: 'updated', unified: ['+new body'], sha256: 'a'.repeat(64) }] }),
      pointer: { revisionId: 'r0001', generation: 1, manifestDigest: 'a'.repeat(64) },
      candidate: { revisionId: 'c-d0001', manifestDigest: 'b'.repeat(64) },
      mode: 'manual',
      rollbackToRevisionId: 'r0001',
      decider: 'human',
    })
    const lines = reason.split('\n')
    expect(lines[0]).toBe('Method publish for skill verify (draft d0001, base r0001, bundle no)')
    expect(lines[1]).toBe(`version switch: active r0001 g1 (aaaaaaaaaaaa) → candidate c-d0001 (bbbbbbbbbbbb); mode manual`)
    expect(lines[2]).toContain('asset diff (1 file')
    expect(reason).toContain('evaluation e-1')
    expect(reason).toContain('admission: admissible')
    expect(reason).toContain('mode: manual (a human decides; the decider is human)')
    expect(reason).toContain('rollback: method_rollback toRevision=r0001')
    expect(lines.at(-1)).toBe('nothing has been written yet; the pointer moves only if this approval is granted and the post-approval re-check still passes')
  })

  it('names the platform policy as the decider in an unmanned graph, and no rollback target on a first publication', () => {
    const reason = renderPublishReason({
      draft,
      report: report(),
      admission,
      calibration,
      diff: [],
      pointer: null,
      candidate: { revisionId: 'c-d0001', manifestDigest: 'b'.repeat(64) },
      mode: 'auto',
      rollbackToRevisionId: null,
      decider: 'platform_policy',
    })
    expect(reason).toContain('version switch: active (none) → candidate c-d0001')
    expect(reason).toContain('mode: auto (the platform policy decides and records; the decider is platform_policy)')
    expect(reason).toContain("rollback: method_rollback toRevision=none (this is the library's first publication)")
  })
})

describe('renderAdmission and renderVersionSwitch', () => {
  it('shows the admission verdict with the calibration it was read under', () => {
    const text = renderAdmission(admission, calibration).join('\n')
    expect(text).toContain('admission: admissible — admissible: gain')
    expect(text).toContain('novelty 0; bundleLevel no')
    expect(text).toContain('calibration: repeated-baseline-evaluations, 3 evaluation(s)')
  })

  it('states the generation of the pointer the switch replaces', () => {
    expect(renderVersionSwitch({ pointer: { revisionId: 'r0001', generation: 4, manifestDigest: 'a'.repeat(64) }, candidate: { revisionId: 'c-d0001', manifestDigest: 'b'.repeat(64) }, mode: 'manual' })).toBe(
      'version switch: active r0001 g4 (aaaaaaaaaaaa) → candidate c-d0001 (bbbbbbbbbbbb); mode manual',
    )
  })
})

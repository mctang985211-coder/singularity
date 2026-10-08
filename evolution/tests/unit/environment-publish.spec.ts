/**
 * Publishing a draft: the only thing that moves is the environment pointer, and
 * it moves through the runtime's own compare-and-swap transaction. A third party
 * that moved the pointer first makes the publish refuse, and nothing is written.
 */

import { describe, expect, it } from 'vitest'
import { emptyRevisionManifest } from '@dangosys/dsh-singularity-task-runtime'
import type {
  EnvironmentPointer,
  EnvironmentPointerCompletion,
  EnvironmentPointerReconcile,
  EnvironmentRevision,
  PublishOutcome,
  PublishRequest,
} from '@dangosys/dsh-singularity-task-runtime'
import { buildPublishPlan } from '../../src/publish/request.ts'
import type { PublishRuntime } from '../../src/publish/pointer.ts'
import { publishDraftEnvironment, rollbackDraftEnvironment } from '../../src/publish/pointer.ts'
import { foldMethods } from '../../src/ledger/fold.ts'
import type { EvolutionRecordV5 } from '../../src/ledger/records.ts'
import { digestOf } from '../../src/shared.ts'
import { LIBRARY, draft, samplePlan } from './method-fixtures.ts'

const AT = '2026-10-08T00:00:00.000Z'

function revisionOf(revisionId: string): EnvironmentRevision {
  const manifest = emptyRevisionManifest({ libraryId: LIBRARY, revisionId, kind: revisionId.startsWith('c-') ? 'candidate' : 'official', basedOn: 'r0001', createdAt: AT })
  return { manifest, root: `/lib/${revisionId}`, skillRoot: `/lib/${revisionId}/skills`, taskTemplatesRoot: `/lib/${revisionId}/task-templates` }
}

function pointerOf(revisionId: string, generation: number): EnvironmentPointer {
  return {
    formatVersion: 1,
    libraryId: LIBRARY,
    revisionId,
    manifestDigest: revisionOf(revisionId).manifest.contentDigest,
    generation,
    publishedAt: AT,
    publishedBy: 'root',
  }
}

interface RuntimeHarness {
  runtime: PublishRuntime
  requests: PublishRequest[]
  failWith?: string
}

function runtimeHarness(input: { pointer: EnvironmentPointer; failWith?: string }): RuntimeHarness {
  const requests: PublishRequest[] = []
  const harness: RuntimeHarness = { requests, runtime: {} as PublishRuntime }
  const outcomeOf = (request: PublishRequest, generation: number): PublishOutcome => {
    const revisionId = request.source.kind === 'draft' ? `c-${request.source.draftId}` : request.source.revisionId
    const completion: EnvironmentPointerCompletion = {
      formatVersion: 1,
      intentId: `${LIBRARY}/g${generation}/${revisionId}`,
      libraryId: LIBRARY,
      direction: request.direction,
      revisionId,
      manifestDigest: revisionOf(revisionId).manifest.contentDigest,
      generation,
      supersededRevisionId: input.pointer.revisionId,
      ...(request.approvalRef === undefined ? {} : { approvalRef: request.approvalRef }),
      actor: request.actor,
      at: AT,
    }
    return { pointer: pointerOf(revisionId, generation), supersededRevisionId: input.pointer.revisionId, completion, recovered: 'fresh' }
  }
  harness.runtime = {
    activePointer: async () => input.pointer,
    revision: async (_sessionId, revisionId) => revisionOf(revisionId),
    publish: async (_sessionId, request) => {
      if (harness.failWith !== undefined) throw new Error(harness.failWith)
      requests.push(request)
      return outcomeOf(request, input.pointer.generation + 1)
    },
    rollback: async (_sessionId, request) => {
      if (harness.failWith !== undefined) throw new Error(harness.failWith)
      requests.push(request)
      return outcomeOf(request, input.pointer.generation + 1)
    },
    reconcile: async (): Promise<EnvironmentPointerReconcile[]> => [],
    completions: async (): Promise<readonly EnvironmentPointerCompletion[]> => [],
  }
  harness.failWith = input.failWith
  return harness
}

function ledgerHarness(records: readonly EvolutionRecordV5[]) {
  const appended: EvolutionRecordV5[] = []
  return {
    appended,
    ledger: {
      libraryId: LIBRARY,
      records: () => [...records, ...appended] as readonly EvolutionRecordV5[],
      append: async (record: EvolutionRecordV5) => {
        appended.push(record)
      },
    },
  }
}

/** The draft and the ledger both freeze the revision the runtime actually holds. */
function frozenDraft() {
  return { ...draft(), candidateRevision: { ...draft().candidateRevision, digest: revisionOf('c-d0001').manifest.contentDigest } }
}

function evaluatedRecords(): EvolutionRecordV5[] {
  const plan = samplePlan()
  return [
    {
      formatVersion: 5,
      kind: 'draft',
      draftId: 'd0001',
      libraryId: LIBRARY,
      assetKind: 'skill',
      identity: 'task-coordination',
      baseRevision: frozenDraft().baseRevision,
      candidateRevision: frozenDraft().candidateRevision,
      rationale: 'fixture',
      sourceRefs: ['diagnosis:d1'],
      actor: 'supervisor',
      at: AT,
    },
    { formatVersion: 5, kind: 'plan', draftId: 'd0001', evaluationId: 'e-1', plan, planDigest: digestOf(plan), report: 'reports/d0001.json', actor: 'supervisor', at: AT },
    {
      formatVersion: 5,
      kind: 'evaluation',
      draftId: 'd0001',
      evaluationId: 'e-1',
      report: 'reports/d0001.json',
      reportDigest: digestOf({ report: 1 }),
      verdict: 'fixed',
      scoreDigest: digestOf({ score: 1 }),
      actor: 'supervisor',
      at: AT,
    },
  ]
}

describe('the publish plan', () => {
  it('builds the compare-and-swap pair from the active pointer and publishes the draft directory', async () => {
    const sources = {
      libraryId: LIBRARY,
      pointer: async () => ({ revisionId: 'r0001', generation: 7, manifestDigest: revisionOf('r0001').manifest.contentDigest }),
      revision: async (revisionId: string) => revisionOf(revisionId),
    }
    const plan = await buildPublishPlan(sources, frozenDraft(), 'apply', 'supervisor', 'approval:1')
    expect(plan.direction).toBe('apply')
    expect(plan.source).toEqual({ kind: 'draft', draftId: 'd0001' })
    expect(plan.expected).toEqual({ revisionId: 'r0001', generation: 7 })
    expect(plan.candidateDigest).toBe(revisionOf('c-d0001').manifest.contentDigest)
  })

  it('refuses a candidate that moved since the draft froze it', async () => {
    const sources = {
      libraryId: LIBRARY,
      pointer: async () => ({ revisionId: 'r0001', generation: 7, manifestDigest: 'x' }),
      revision: async (revisionId: string) => revisionOf(revisionId),
    }
    const moved = { ...frozenDraft(), candidateRevision: { ...frozenDraft().candidateRevision, digest: digestOf({ other: 1 }) } }
    await expect(buildPublishPlan(sources, moved, 'apply', 'supervisor', 'approval:1')).rejects.toThrow(/moved since it was evaluated/)
  })

  it('names the baseline revision as the rollback target', async () => {
    const sources = {
      libraryId: LIBRARY,
      pointer: async () => ({ revisionId: 'c-d0001', generation: 8, manifestDigest: 'x' }),
      revision: async (revisionId: string) => revisionOf(revisionId),
    }
    const plan = await buildPublishPlan(sources, frozenDraft(), 'rollback', 'supervisor', 'approval:2')
    expect(plan.source).toEqual({ kind: 'revision', revisionId: 'r0001' })
  })
})

describe('publishing a draft', () => {
  it('appends the published line the runtime’s own completion describes', async () => {
    const { ledger, appended } = ledgerHarness(evaluatedRecords())
    const { runtime } = runtimeHarness({ pointer: pointerOf('r0001', 1) })
    const outcome = await publishDraftEnvironment({ caller: 's1', ledger, runtime }, 'd0001', 'supervisor', 'approval:1')
    expect(outcome.pointer.revisionId).toBe('c-d0001')
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({
      kind: 'published',
      draftId: 'd0001',
      revisionId: 'c-d0001',
      supersededRevisionId: 'r0001',
      approvalRef: 'approval:1',
    })
    const view = foldMethods(ledger.records()).get('d0001')!
    expect(view.status).toBe('published')
  })

  it('re-checks the report before it reads the pointer', async () => {
    const { ledger, appended } = ledgerHarness(evaluatedRecords())
    const { runtime, requests } = runtimeHarness({ pointer: pointerOf('r0001', 1) })
    const seen: string[] = []
    await expect(
      publishDraftEnvironment(
        {
          caller: 's1',
          ledger,
          runtime,
          validatePrePublish: async () => {
            seen.push('checked')
            throw new Error('evolution: the baseline revision moved since the report was written')
          },
        },
        'd0001',
        'supervisor',
        'approval:1',
      ),
    ).rejects.toThrow(/baseline revision moved/)
    expect(seen).toEqual(['checked'])
    expect(requests).toHaveLength(0)
    expect(appended).toHaveLength(0)
  })

  it('writes nothing when the pointer changed under it', async () => {
    const { ledger, appended } = ledgerHarness(evaluatedRecords())
    const { runtime } = runtimeHarness({ pointer: pointerOf('r0001', 1), failWith: 'task-runtime: environment-pointer-changed' })
    await expect(publishDraftEnvironment({ caller: 's1', ledger, runtime }, 'd0001', 'supervisor', 'approval:1')).rejects.toThrow(
      /environment-pointer-changed/,
    )
    expect(appended).toHaveLength(0)
    expect(foldMethods(ledger.records()).get('d0001')!.status).toBe('evaluated')
  })

  it('refuses to publish a discarded draft and an unknown draft', async () => {
    const { ledger } = ledgerHarness([
      ...evaluatedRecords(),
      { formatVersion: 5, kind: 'discard', draftId: 'd0001', reason: 'no evidence', actor: 'supervisor', at: AT },
    ])
    const { runtime, requests } = runtimeHarness({ pointer: pointerOf('r0001', 1) })
    await expect(publishDraftEnvironment({ caller: 's1', ledger, runtime }, 'd0001', 'supervisor', 'approval:1')).rejects.toThrow(/discarded/)
    await expect(publishDraftEnvironment({ caller: 's1', ledger, runtime }, 'd9999', 'supervisor', 'approval:1')).rejects.toThrow(/unknown draft/)
    expect(requests).toHaveLength(0)
  })
})

describe('rolling a published draft back', () => {
  it('switches the pointer to the superseded revision and records the rollback', async () => {
    const { ledger, appended } = ledgerHarness([
      ...evaluatedRecords(),
      {
        formatVersion: 5,
        kind: 'published',
        draftId: 'd0001',
        revisionId: 'c-d0001',
        supersededRevisionId: 'r0001',
        intentId: `${LIBRARY}/g2/c-d0001`,
        approvalRef: 'approval:1',
        actor: 'supervisor',
        at: AT,
      },
    ])
    const { runtime, requests } = runtimeHarness({ pointer: pointerOf('c-d0001', 2) })
    const outcome = await rollbackDraftEnvironment({ caller: 's1', ledger, runtime }, 'd0001', 'supervisor', 'approval:2')
    expect(outcome.pointer.revisionId).toBe('r0001')
    expect(requests[0]!.direction).toBe('rollback')
    expect(requests[0]!.expected).toEqual({ revisionId: 'c-d0001', generation: 2 })
    expect(appended[0]).toMatchObject({ kind: 'rolledback', draftId: 'd0001', revisionId: 'r0001', supersededRevisionId: 'c-d0001' })
  })

  it('refuses to roll back a draft that was never published', async () => {
    const { ledger } = ledgerHarness(evaluatedRecords())
    const { runtime, requests } = runtimeHarness({ pointer: pointerOf('r0001', 1) })
    await expect(rollbackDraftEnvironment({ caller: 's1', ledger, runtime }, 'd0001', 'supervisor', 'approval:2')).rejects.toThrow(
      /requires a published draft|only a published draft/,
    )
    expect(requests).toHaveLength(0)
  })
})

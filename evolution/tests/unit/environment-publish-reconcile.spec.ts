/**
 * Reconciling publishes: a pointer switch that landed before the process died
 * gets its ledger line on the next start, and a completion nobody can attribute
 * to a draft is reported rather than invented onto one.
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
import { reconcilePublishes } from '../../src/publish/pointer.ts'
import { foldMethods } from '../../src/ledger/fold.ts'
import type { EvolutionRecordV5 } from '../../src/ledger/records.ts'
import { digestOf } from '../../src/shared.ts'
import { LIBRARY, draft, samplePlan } from './method-fixtures.ts'

const AT = '2026-10-08T00:00:00.000Z'

function revisionOf(revisionId: string): EnvironmentRevision {
  const manifest = emptyRevisionManifest({ libraryId: LIBRARY, revisionId, kind: 'candidate', basedOn: 'r0001', createdAt: AT })
  return { manifest, root: `/lib/${revisionId}`, skillRoot: `/lib/${revisionId}/skills`, taskTemplatesRoot: `/lib/${revisionId}/task-templates` }
}

function completion(input: {
  direction: 'publish' | 'rollback'
  revisionId: string
  intentId: string
  supersededRevisionId?: string | null
}): EnvironmentPointerCompletion {
  return {
    formatVersion: 1,
    intentId: input.intentId,
    libraryId: LIBRARY,
    direction: input.direction,
    revisionId: input.revisionId,
    manifestDigest: revisionOf(input.revisionId).manifest.contentDigest,
    generation: 2,
    supersededRevisionId: input.supersededRevisionId ?? 'r0001',
    actor: 'root',
    at: AT,
  }
}

function host(records: readonly EvolutionRecordV5[], completions: readonly EnvironmentPointerCompletion[]) {
  const appended: EvolutionRecordV5[] = []
  const reconciles: EnvironmentPointerReconcile[] = [{ intentId: completions[0]?.intentId ?? 'none', direction: 'publish', result: 'completed-switched', revisionId: 'c-d0001' }]
  return {
    appended,
    host: {
      caller: 's1',
      ledger: {
        libraryId: LIBRARY,
        records: () => [...records, ...appended] as readonly EvolutionRecordV5[],
        append: async (record: EvolutionRecordV5) => {
          appended.push(record)
        },
      },
      runtime: {
        activePointer: async (): Promise<EnvironmentPointer> => {
          throw new Error('reconcile does not read the pointer directly')
        },
        revision: async (_s: string, revisionId: string) => revisionOf(revisionId),
        publish: async (_s: string, _r: PublishRequest): Promise<PublishOutcome> => {
          throw new Error('reconcile does not publish')
        },
        rollback: async (_s: string, _r: PublishRequest): Promise<PublishOutcome> => {
          throw new Error('reconcile does not roll back')
        },
        reconcile: async () => reconciles,
        completions: async () => completions,
      },
    },
  }
}

function evaluatedDraftRecords(): EvolutionRecordV5[] {
  const method = { ...draft(), candidateRevision: { ...draft().candidateRevision, digest: revisionOf('c-d0001').manifest.contentDigest } }
  const plan = samplePlan()
  return [
    {
      formatVersion: 5,
      kind: 'draft',
      draftId: 'd0001',
      libraryId: LIBRARY,
      assetKind: 'skill',
      identity: method.identity,
      baseRevision: method.baseRevision,
      candidateRevision: method.candidateRevision,
      rationale: method.rationale,
      sourceRefs: [...method.sourceRefs],
      actor: method.actor,
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

describe('reconcilePublishes', () => {
  it('appends the publish line a completion describes when the ledger holds none', async () => {
    const { host: publishHost, appended } = host(evaluatedDraftRecords(), [
      completion({ direction: 'publish', revisionId: 'c-d0001', intentId: `${LIBRARY}/g2/c-d0001` }),
    ])
    const result = await reconcilePublishes(publishHost)
    expect(result).toHaveLength(1)
    expect(appended).toHaveLength(1)
    expect(appended[0]).toMatchObject({ kind: 'published', draftId: 'd0001', revisionId: 'c-d0001', supersededRevisionId: 'r0001' })
  })

  it('does not write a second line for a completion the ledger already recorded', async () => {
    const { host: publishHost, appended } = host(
      [
        ...evaluatedDraftRecords(),
        {
          formatVersion: 5,
          kind: 'published',
          draftId: 'd0001',
          revisionId: 'c-d0001',
          supersededRevisionId: 'r0001',
          intentId: `${LIBRARY}/g2/c-d0001`,
          actor: 'root',
          at: AT,
        },
      ],
      [completion({ direction: 'publish', revisionId: 'c-d0001', intentId: `${LIBRARY}/g2/c-d0001` })],
    )
    await reconcilePublishes(publishHost)
    expect(appended).toHaveLength(0)
  })

  it('records a rollback completion without a draft', async () => {
    const { host: publishHost, appended } = host([], [
      completion({ direction: 'rollback', revisionId: 'r0001', intentId: `${LIBRARY}/g3/r0001`, supersededRevisionId: 'c-d0001' }),
    ])
    await reconcilePublishes(publishHost)
    expect(appended[0]).toMatchObject({ kind: 'rolledback', draftId: null, revisionId: 'r0001', supersededRevisionId: 'c-d0001' })
  })

  it('reports a completion no draft can explain instead of writing it onto one', async () => {
    const { host: publishHost, appended } = host(evaluatedDraftRecords(), [
      completion({ direction: 'publish', revisionId: 'c-unknown', intentId: `${LIBRARY}/g4/c-unknown` }),
    ])
    const result = await reconcilePublishes(publishHost)
    expect(appended).toHaveLength(0)
    expect(result.at(-1)).toMatchObject({ result: 'blocked', revisionId: 'c-unknown' })
  })

  it('leaves the ledger foldable after a reconcile', async () => {
    const { host: publishHost } = host(evaluatedDraftRecords(), [
      completion({ direction: 'publish', revisionId: 'c-d0001', intentId: `${LIBRARY}/g2/c-d0001` }),
    ])
    await reconcilePublishes(publishHost)
    expect(() => foldMethods(publishHost.ledger.records())).not.toThrow()
  })
})

/**
 * The method fact producer the read model folds into a graph view: registered on
 * `GraphViewService`, a graph's method face is read from the environment pointer
 * and the v5 ledger the `method_*` tools read — and a store key this plane cannot
 * resolve answers nothing rather than a default.
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId } from '@dangosys/dsh-singularity-task'
import { describe, expect, it } from 'vitest'
import { GraphViewService } from '../../../context/src/view/service.ts'
import { methodFactsReader } from '../../src/method-facts.ts'
import { GRAPH, forgeEvaluation, methodWorld, type MethodWorld } from './method-tools.fixture.ts'

const PROTOCOL = { id: 'singularity/graph@2', version: 2, since: 1 }

/** A deployment whose graph registry, task store and task runtime are the ones this reader resolves through. */
function deployment(world: MethodWorld): GraphViewService {
  const ctx = new Context()
  const record = {
    id: GRAPH,
    name: GRAPH,
    createdAt: 1,
    rootSessionId: SessionId(GRAPH),
    protocol: PROTOCOL,
    rsi: { task: 'improve', iterationRounds: 3, humanReview: true },
  }
  ctx.provide('graphs', { get: async () => record, list: async () => [record] } as never)
  ctx.provide('task', { openStore: async () => ({ tasks: [], runs: [], reviews: [], diagnoses: [], evidence: [], obligations: [], capabilities: {}, receipts: [] }), receiptFor: async () => undefined } as never)
  ctx.provide('taskRuntime', {
    config: {},
    libraryRootsForSession: async () => ({ id: world.library.id, root: world.library.root }),
  } as never)
  const service = new GraphViewService(ctx)
  service.registerCoordinationFacts({ assignments: async () => [] })
  service.registerMethodFacts(methodFactsReader(ctx))
  return service
}

describe('the method fact producer', () => {
  it('hands the view service the active revision and the latest evaluation the v5 stores hold', async () => {
    const world = await methodWorld()
    try {
      const { draftId } = await forgeEvaluation(world)
      const service = deployment(world)
      const view = await service.view(GRAPH)
      // The pointer's own revision, before any switch: the library is born at r0001.
      expect(view.revision).toMatchObject({ revisionId: 'r0001', origin: 'graph-initial' })
      // The latest draft's settled evaluation, read through the ledger the tools share.
      expect(view.evaluation).toMatchObject({ state: 'decided', candidateRef: draftId })
    } finally {
      await world.dispose()
    }
  })

  it('answers nothing for a store key no graph publishes, rather than reading a default', async () => {
    const world = await methodWorld()
    try {
      const service = deployment(world)
      const view = await service.view(GRAPH)
      expect(view.revision).toMatchObject({ revisionId: 'r0001' })
      expect(view.evaluation).toBeNull()

      const bare = methodFactsReader(new Context())
      expect(await bare.activeRevision(rootTaskStoreId('nobody'))).toBeNull()
      expect(await bare.latestEvaluation(rootTaskStoreId('nobody'))).toBeNull()
    } finally {
      await world.dispose()
    }
  })
})

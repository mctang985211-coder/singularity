import { describe, expect, test } from 'vitest'
import type { GraphRecord } from '../../src/types.ts'
import { GraphsState } from '../../src/service/state.ts'

function graph(id: string): GraphRecord {
  return {
    id,
    name: id,
    envId: `env-${id}`,
    rootSessionId: `s-${id}` as GraphRecord['rootSessionId'],
    graphStoreId: `sg-g-${id}`,
    layoutStoreId: `sg-l-${id}`,
    createdAt: 1,
    ready: true,
  }
}

describe('graphs registry replay of pre-protocol logs', () => {
  test('a persisted graph/rsi-progress event replays to nothing', () => {
    const state = new GraphsState()
    state.apply({ kind: 'graph/add', graph: graph('graph1') })
    const before = state.snapshot()
    // The event kind is gone from the union; a log written before the protocol
    // marker still carries it, so replay tolerates it verbatim.
    const legacy = { kind: 'graph/rsi-progress', id: 'graph1', progress: { round: 2, phase: 'running' } }
    state.apply(legacy as never)
    expect(state.snapshot()).toEqual(before)
  })

  test('a graph record replayed from an old log carries no protocol marker and reads as legacy', () => {
    const state = new GraphsState()
    state.apply({ kind: 'graph/add', graph: graph('graph1') })
    expect(state.get('graph1').protocol).toBeUndefined()
  })
})

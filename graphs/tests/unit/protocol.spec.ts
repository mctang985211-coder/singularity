import { describe, expect, test } from 'vitest'
import {
  GRAPH_PROTOCOL_V2,
  GraphSealedError,
  assertCurrentGraph,
  graphAccess,
  protocolOf,
  type GraphProtocol,
} from '../../src/protocol.ts'

function stamped(since = 1): GraphProtocol {
  return { id: GRAPH_PROTOCOL_V2, version: 2, since }
}

describe('graph protocol marker', () => {
  test('a marked graph reads as current and answers its own marker', () => {
    const graph = { id: 'graph1', protocol: stamped(42) }
    expect(protocolOf(graph)).toEqual(stamped(42))
    const access = graphAccess(graph)
    expect(access.mode).toBe('current')
    expect(assertCurrentGraph(graph)).toEqual(stamped(42))
  })

  test('an unmarked graph reads as legacy-readonly with a named reason', () => {
    const graph = { id: 'graph7' }
    expect(protocolOf(graph)).toBeUndefined()
    const access = graphAccess(graph)
    expect(access.mode).toBe('legacy-readonly')
    expect(access.mode === 'legacy-readonly' && access.reason).toContain('graph7')
  })

  test('assertCurrentGraph refuses an unmarked graph with graph-sealed', () => {
    const graph = { id: 'graph9' }
    let thrown: unknown
    try {
      assertCurrentGraph(graph)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(GraphSealedError)
    const sealed = thrown as GraphSealedError
    expect(sealed.code).toBe('graph-sealed')
    expect(sealed.graphId).toBe('graph9')
  })

  test('the marker literal is the current protocol identity', () => {
    expect(GRAPH_PROTOCOL_V2).toBe('singularity/graph@2')
    expect(stamped().version).toBe(2)
  })
})

/**
 * The one graph read projection: one cache per fact fingerprint, a named
 * refusal when a fact producer is missing, and an access mode that never
 * depends on either.
 */

import { describe, expect, test } from 'vitest'
import { rootTaskStoreId } from '../../../task/src/index.ts'
import type { GraphRevisionWire } from '../../../graphs/src/wire.ts'
import { FixtureStack } from '../support/stack.ts'
import type { CoordinationAssignmentFacts } from '../../src/index.ts'

const REVISION: GraphRevisionWire = {
  revisionId: 'r0001',
  manifestDigest: 'digest-1',
  origin: 'published',
  publishedAt: '2026-10-08T00:00:00.000Z',
}

const EVALUATION = {
  state: 'decided' as const,
  reportRef: 'evaluation-1',
  candidateRef: 'c-1',
  decidedAt: '2026-10-08T00:00:00.000Z',
}

const ASSIGNMENT: CoordinationAssignmentFacts = {
  assignmentId: 'a-1',
  role: 'supervisor',
  round: 1,
  sessionId: 's-supervisor',
  sourceTaskId: 't-root',
  sourceRunId: 'r-root',
  state: 'open',
}

/** A deployment with one current graph and both fact planes mounted. */
function deployed(): { stack: FixtureStack; key: string } {
  const stack = new FixtureStack()
  stack.graph({ id: 'g-1', rootSessionId: 's-root', name: 'the release graph', rounds: 2 })
  stack.registerViewFacts('coordination', 'method')
  return { stack, key: rootTaskStoreId('s-root') }
}

/** The same deployment with no fact plane mounted at all. */
function bare(): { stack: FixtureStack; key: string } {
  const stack = new FixtureStack()
  stack.graph({ id: 'g-1', rootSessionId: 's-root', name: 'the release graph', rounds: 2 })
  return { stack, key: rootTaskStoreId('s-root') }
}

describe('one projection per fact fingerprint', () => {
  test('reads the facts once and answers the same projection again', async () => {
    const { stack, key } = deployed()
    stack.viewFactsOf(key, { revision: REVISION, evaluation: EVALUATION, assignments: [ASSIGNMENT] })

    const first = await stack.graphView.view('g-1')
    const second = await stack.graphView.view('g-1')

    expect(second).toBe(first)
    expect(stack.viewReads.activeRevision).toHaveBeenCalledTimes(1)
    expect(stack.viewReads.latestEvaluation).toHaveBeenCalledTimes(1)
    expect(stack.viewReads.assignments).toHaveBeenCalledTimes(1)
    // The readers are asked under the graph's own fact key, not the registry id.
    expect(stack.viewReads.assignments).toHaveBeenCalledExactlyOnceWith(key)
  })

  test('projects the graph record, its version, its evaluation and its derived progress', async () => {
    const { stack, key } = deployed()
    stack.viewFactsOf(key, { revision: REVISION, evaluation: EVALUATION, assignments: [ASSIGNMENT] })

    const view = await stack.graphView.view('g-1')

    expect(view.formatVersion).toBe(2)
    expect(view.graph).toEqual({ id: 'g-1', name: 'the release graph', createdAt: 1_760_000_000_000 })
    expect(view.access).toEqual({ mode: 'current' })
    expect(view.revision).toEqual(REVISION)
    expect(view.evaluation).toEqual(EVALUATION)
    expect(view.progress).toEqual({ round: 1, rounds: 2, phase: 'running' })
    expect(Number.isSafeInteger(view.generation)).toBe(true)
  })

  test('reduces the whole projection again once the stores publish a change', async () => {
    const { stack, key } = deployed()
    stack.viewFactsOf(key, { revision: REVISION, evaluation: EVALUATION, assignments: [ASSIGNMENT] })
    const before = await stack.graphView.view('g-1')

    stack.viewFactsOf(key, { revision: null, evaluation: null, assignments: [] })
    stack.publishChange('graphs/change')
    const after = await stack.graphView.view('g-1')

    expect(after).not.toBe(before)
    expect(after.generation).not.toBe(before.generation)
    expect(after.revision).toBeNull()
    expect(after.evaluation).toBeNull()
    expect(after.progress).toEqual({ round: 0, rounds: 2, phase: 'idle' })
    expect(stack.viewReads.assignments).toHaveBeenCalledTimes(2)
  })

  test('reduces again when the graph store or the task store changes', async () => {
    const { stack, key } = deployed()
    stack.viewFactsOf(key, { assignments: [ASSIGNMENT] })
    const first = await stack.graphView.view('g-1')
    stack.publishChange('graph/change')
    const second = await stack.graphView.view('g-1')
    stack.publishChange('task/change')
    const third = await stack.graphView.view('g-1')

    expect(second).not.toBe(first)
    expect(third).not.toBe(second)
    expect(second).toEqual(first)
  })
})

describe('a fact producer this deployment lacks', () => {
  test('refuses a method read by name instead of answering a default', async () => {
    const { stack, key } = bare()
    stack.registerViewFacts('coordination')
    stack.viewFactsOf(key, { assignments: [] })

    await expect(stack.graphView.view('g-1')).rejects.toMatchObject({
      name: 'ReadSourceUnavailableError',
      code: 'read-source-unavailable',
      source: 'method',
    })
  })

  test('refuses a coordination read by name instead of answering a default', async () => {
    const { stack, key } = bare()
    stack.registerViewFacts('method')
    stack.viewFactsOf(key, { revision: REVISION })

    await expect(stack.graphView.view('g-1')).rejects.toMatchObject({
      name: 'ReadSourceUnavailableError',
      code: 'read-source-unavailable',
      source: 'coordination',
    })
  })

  test('refuses before it reads anything, so no half-projection exists', async () => {
    const { stack } = bare()

    await expect(stack.graphView.view('g-1')).rejects.toMatchObject({ source: 'coordination' })
    expect(stack.viewReads.assignments).not.toHaveBeenCalled()
    expect(stack.viewReads.activeRevision).not.toHaveBeenCalled()
  })
})

describe('a sealed legacy graph', () => {
  test('is read as history-only, and never through a current-protocol answer', async () => {
    const stack = new FixtureStack()
    stack.graph({ id: 'g-old', rootSessionId: 's-old', sealed: true })
    stack.registerViewFacts('coordination', 'method')
    stack.viewFactsOf(rootTaskStoreId('s-old'), { assignments: [] })

    const view = await stack.graphView.view('g-old')

    expect(view.access.mode).toBe('legacy-readonly')
    expect(view.access.reason).toContain('singularity/graph@2')
    expect(view.revision).toBeNull()
    expect(view.evaluation).toBeNull()
  })
})

describe('the registry list', () => {
  test('answers one view per graph, each carrying its own access mode', async () => {
    const stack = new FixtureStack()
    stack.graph({ id: 'g-1', rootSessionId: 's-root', rounds: 1 })
    stack.graph({ id: 'g-old', rootSessionId: 's-old', sealed: true })
    stack.registerViewFacts('coordination', 'method')

    const views = await stack.graphView.summaries()

    expect(views.map(view => view.graph.id)).toEqual(['g-1', 'g-old'])
    expect(views.map(view => view.access.mode)).toEqual(['current', 'legacy-readonly'])
  })

  test('refuses a graph the registry does not hold, in the registry\'s own words', async () => {
    const { stack } = deployed()

    await expect(stack.graphView.view('g-nobody')).rejects.toThrow('unknown graph')
  })
})

/** An empty graph enters the real task/agent stack before its first contract exists. */
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { rootTaskStoreId } from '../../task/src/index.ts'
import { disposeRunStacks, startRunStack } from '../support/run-stack.ts'

const ROOT = 's-empty-library-root' as SessionId
const STORE = rootTaskStoreId(ROOT)
afterEach(disposeRunStacks)

describe('empty graph bootstrap into a graph-owned method library', () => {
  it('adopts an empty store with its real session, then binds generic guidance and executes a child', async () => {
    const h = await startRunStack({ roots: [ROOT], tools: true })
    const graphForSession = h.ctx.graphs.graphForSession.bind(h.ctx.graphs)
    const observed: string[] = []
    h.ctx.graphs.graphForSession = async id => {
      observed.push(id)
      if (id === STORE) throw new Error(`graphs: session ${id} not in graph`)
      return graphForSession(id)
    }
    expect(await h.runtime.adoptRoot(STORE, ROOT)).toMatchObject({ adopted: false })
    expect(observed).not.toContain(STORE)
    const library = await h.runtime.libraryForSession(ROOT)
    // The library view reports the revision's own entries: an empty graph has
    // no task templates and only the seeded coordination guidance.
    expect((await h.runtime.libraryRead(ROOT)).taskTemplates).toEqual([])
    const root = await h.root(ROOT, {
      objective: 'Deliver a checked result from an initially empty graph',
      acceptanceCriteria: [{ description: 'The delivered result passes its check', command: 'true' }],
      requiredCapabilities: ['execute-task'],
    })
    const run = await h.task.runIn(STORE, root.runId)
    expect(run.taskTemplatesRoot).toBe(library.taskTemplatesRoot)
    expect(run.providerBinding?.skills.map(item => item.name)).toEqual(['task-coordination'])
    const batch = await h.runtime.decomposeAndRun(STORE, root.taskId, root.runId, ROOT, {
      reason: 'Produce an independently checked child result',
      children: [{ objective: 'Produce the child result', acceptanceCriteria: [{ description: 'The child result passes its check', command: 'true' }], requiredCapabilities: ['execute-task'] }],
    })
    expect((await h.runtime.awaitBatch(STORE, batch.batchId)).map(item => item.status)).toEqual(['verified'])
    const child = await h.task.taskIn(STORE, batch.childTaskIds[0]!)
    const childRun = await h.task.runIn(STORE, child.runIds[0]!)
    // The child resolves the same graph library: the same identity and the same
    // revision roots, read after the initial revision was fixed.
    expect(await h.runtime.libraryForSession(childRun.sessionId)).toMatchObject({
      id: library.id,
      taskTemplatesRoot: library.taskTemplatesRoot,
      skillRoot: library.skillRoot,
    })
    await h.runtime.submitResult(ROOT, { summary: 'The complete checked result is delivered' })
  })
})

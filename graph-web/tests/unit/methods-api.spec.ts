/**
 * The console's method read routes against a real library and a real v5 ledger:
 * the same facts the `method_*` tools read, one draft's evaluation in full, the
 * publication approval a person has not answered, and the named refusal when the
 * graph view service cannot answer. Nothing on this surface writes.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { METHODS_PATH, registerMethods, subscribeMethods } from '../../src/web/api/methods.ts'
import {
  GRAPH,
  consoleCtx,
  graphRegistryFor,
  graphViewWire,
  json,
  methodConsole,
  methodWorld,
  mockReq,
  mockRes,
  publicationCard,
  writesOf,
} from './console.fixture.ts'

const opened: { dispose(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map(world => world.dispose()))
})

describe('GET /singularity/methods', () => {
  it('serves the library state the method tools read, and the publication approval awaiting an answer', async () => {
    const console = await methodConsole()
    opened.push(console.world)
    const revision = (await console.world.revision('r0001'))!
    const stop = registerMethods(console.ctx as never)
    // Nothing about a read may write: every environment entry that moves a draft or a pointer is counted before and after.
    const writesBefore = writesOf(console.world.calls)
    const res = mockRes()
    await console.handlers.get(METHODS_PATH)!(mockReq('GET', `${METHODS_PATH}?graphId=${GRAPH}`), res as never)

    expect(res.statusCode).toBe(200)
    const payload = json(res)
    const pointer = (await console.world.pointer())!
    expect(payload.graphId).toBe(GRAPH)
    expect(payload.libraryId).toBe(GRAPH)
    expect(payload.environment).toMatchObject({
      libraryId: GRAPH,
      revisionId: pointer.revisionId,
      generation: pointer.generation,
      manifestDigest: revision.manifest.contentDigest,
      readOnly: false,
      protocol: 'environment-revision',
    })
    expect(payload.drafts).toHaveLength(1)
    expect(payload.drafts[0]).toMatchObject({
      draftId: console.draftId,
      kind: 'skill',
      identity: 'verify',
      status: 'evaluated',
      baseRevision: { revisionId: 'r0001' },
      evaluation: { evaluationId: console.evaluationId, verdict: 'fixed' },
      published: null,
      rolledback: null,
      trialSides: 2,
    })
    // The admission is the landed record's, read rather than recomputed.
    expect(payload.drafts[0].admission).toEqual({
      ...console.decision.admissions[0],
      candidateId: console.draftId,
    })
    expect(payload.drafts[0].admission.admissible).toBe(false)
    expect(payload.history.entries).toHaveLength(1)
    expect(payload.history.entries[0]).toMatchObject({ candidateId: console.draftId, reasonCode: console.decision.admissions[0]!.reasonCode })
    expect(payload.history.refutations).toHaveLength(1)
    expect(payload.intent).toBeNull()
    // Only the publication card is a publication: the other pending approval is not one.
    expect(payload.approvals).toEqual([
      {
        id: publicationCard.id,
        sessionId: publicationCard.sessionId,
        createdAt: publicationCard.createdAt,
        prompt: publicationCard.prompt,
      },
    ])
    expect(payload.view).toEqual(graphViewWire)
    expect(payload.viewRefusal).toBeNull()

    // The whole read is read-only: no environment entry that writes was reached.
    expect(writesOf(console.world.calls)).toEqual(writesBefore)
    stop()
    expect(console.handlers.get(METHODS_PATH)).toBeUndefined()
  })

  it('serves one draft in full: its plan, its report, its admission and its file difference', async () => {
    const console = await methodConsole()
    opened.push(console.world)
    registerMethods(console.ctx as never)
    const res = mockRes()
    await console.handlers.get(`${METHODS_PATH}/*`)!(
      mockReq('GET', `${METHODS_PATH}/${console.draftId}?graphId=${GRAPH}`),
      res as never,
    )

    expect(res.statusCode).toBe(200)
    const payload = json(res)
    expect(payload).toMatchObject({
      graphId: GRAPH,
      libraryId: GRAPH,
      status: 'evaluated',
      draft: { draftId: console.draftId, identity: 'verify', kind: 'skill' },
      plan: { draftId: console.draftId },
      evaluation: { evaluationId: console.evaluationId },
      report: { draftId: console.draftId, evaluationId: console.evaluationId, verdict: 'fixed' },
    })
    expect(payload.planDigest).toHaveLength(64)
    // One settled side per sample: the ledger records both sides, the report pairs them.
    expect(payload.trials.map((trial: { side: string }) => trial.side)).toEqual(['baseline', 'candidate'])
    expect(payload.trials[0]).toMatchObject({ sampleTaskId: 't1', role: 'observed-failure' })
    expect(payload.report.trials).toHaveLength(1)
    expect(payload.decision.admissions[0].candidateId).toBe(console.draftId)
    expect(payload.admission).toEqual(console.decision.admissions[0])
    const staged = (await console.world.draft(console.draftId))!
    expect(payload.diff).toMatchObject({
      from: 'r0001',
      to: staged.manifest.revisionId,
      files: [{ path: 'skills/verify/SKILL.md', change: 'added' }],
    })
    expect(payload.diff.files[0].sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(payload.diff.digest).toHaveLength(64)

    const missing = mockRes()
    await console.handlers.get(`${METHODS_PATH}/*`)!(
      mockReq('GET', `${METHODS_PATH}/d9999?graphId=${GRAPH}`),
      missing as never,
    )
    expect(missing.statusCode).toBe(404)
    expect(json(missing)).toEqual({ error: 'methods: unknown draft "d9999"' })
  })

  it('names a graph view service that cannot answer instead of defaulting to a view', async () => {
    const world = await methodConsole()
    opened.push(world.world)
    const bare = consoleCtx({ ...world.world.ctx, graphs: graphRegistryFor(world.world) })
    registerMethods(bare.ctx as never)
    const res = mockRes()
    await bare.handlers.get(METHODS_PATH)!(mockReq('GET', `${METHODS_PATH}?graphId=${GRAPH}`), res as never)
    expect(res.statusCode).toBe(200)
    expect(json(res).view).toBeNull()
    expect(json(res).viewRefusal).toBe('no graph view service is mounted in this deployment')

    const refusing = consoleCtx({
      ...world.world.ctx,
      graphs: graphRegistryFor(world.world),
      singularityGraphView: {
        view: async () => {
          throw new Error(
            "no method fact source is registered in this deployment, so a graph's active revision and latest evaluation cannot be read",
          )
        },
      },
    })
    registerMethods(refusing.ctx as never)
    const refused = mockRes()
    await refusing.handlers.get(METHODS_PATH)!(mockReq('GET', `${METHODS_PATH}?graphId=${GRAPH}`), refused as never)
    expect(refused.statusCode).toBe(200)
    // The pointer facts this boundary read itself are still served beside the refusal.
    expect(json(refused).view).toBeNull()
    expect(json(refused).viewRefusal).toContain('no method fact source is registered')
    expect(json(refused).environment.revisionId).toBe('r0001')
  })

  it('points a legacy graph at its one history route instead of serving drafts it has none of', async () => {
    const world = await methodWorld({ readOnly: true })
    opened.push(world)
    const { ctx, handlers } = consoleCtx({ ...world.ctx, graphs: graphRegistryFor(world) })
    registerMethods(ctx as never)
    const res = mockRes()
    await handlers.get(METHODS_PATH)!(mockReq('GET', `${METHODS_PATH}?graphId=${GRAPH}`), res as never)
    expect(res.statusCode).toBe(400)
    expect(res.body).toContain(`GET /singularity/graphs/${GRAPH}/history`)
    expect(writesOf(world.calls)).toEqual([])
  })

  it('refuses a request without a graph, an unknown filter value and every write method', async () => {
    const console = await methodConsole()
    opened.push(console.world)
    registerMethods(console.ctx as never)
    const serve = console.handlers.get(METHODS_PATH)!

    const noGraph = mockRes()
    await serve(mockReq('GET', METHODS_PATH), noGraph as never)
    expect(noGraph.statusCode).toBe(400)

    const badKind = mockRes()
    await serve(mockReq('GET', `${METHODS_PATH}?graphId=${GRAPH}&kind=proposal`), badKind as never)
    expect(badKind.statusCode).toBe(400)
    expect(badKind.body).toContain('unknown kind "proposal"')

    const unknownGraph = mockRes()
    await serve(mockReq('GET', `${METHODS_PATH}?graphId=nope`), unknownGraph as never)
    expect(unknownGraph.statusCode).toBe(400)

    const posted = mockRes()
    await serve(mockReq('POST', `${METHODS_PATH}?graphId=${GRAPH}`), posted as never)
    expect(posted.statusCode).toBe(405)

    const listed = mockRes()
    await serve(mockReq('GET', `${METHODS_PATH}?graphId=${GRAPH}&kind=task-template`), listed as never)
    expect(listed.statusCode).toBe(200)
    expect(json(listed).drafts).toEqual([])
    // A filter narrows the list, never the history: the rounds the console folds stay every draft's.
    expect(json(listed).history.entries).toHaveLength(1)
  })
})

describe('the method change stream', () => {
  it('forwards a method change onto the event stream as a methods frame', () => {
    const { ctx, listeners } = consoleCtx({})
    const published: { name: string; value: unknown }[] = []
    const stop = subscribeMethods(ctx as never, { publishEvent: (name, value) => published.push({ name, value }) })
    const forwards = [...(listeners.get('methods/change') ?? [])]
    expect(forwards).toHaveLength(1)
    forwards[0]!({ draftId: 'd0001', revisionId: 'r0002', actor: 's-supervisor' } as never)
    expect(published).toEqual([
      { name: 'methods', value: { draftId: 'd0001', revisionId: 'r0002', actor: 's-supervisor' } },
    ])
    stop()
    expect([...(listeners.get('methods/change') ?? [])]).toHaveLength(0)
  })
})

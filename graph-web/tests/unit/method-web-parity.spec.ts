/**
 * Web and tool answer from one library: `GET /singularity/methods` and the
 * `method_list` tool read the same pointer, the same v5 ledger and the same
 * landed strategy decision, and the evaluator's own projection is the third
 * reading of the same bytes. What the console shows and what a model is told have
 * to name the same revision, generation, draft, evaluation and reason code — and
 * neither of them may write.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { draftViews, foldMethods, openMethodLedger } from '@dangosys/dsh-singularity-evolution'
import { defineMethodListTool } from '../../../agent-singularity/src/tools/method-list.ts'
import { METHODS_PATH, registerMethods } from '../../src/web/api/methods.ts'
import { GRAPH, json, methodConsole, mockReq, mockRes, writesOf } from './console.fixture.ts'

const opened: { dispose(): Promise<void> }[] = []

afterEach(async () => {
  await Promise.all(opened.splice(0).map(world => world.dispose()))
})

describe('the console and the method_list tool', () => {
  it('report the same revision, drafts, evaluation and admission', async () => {
    const console = await methodConsole()
    opened.push(console.world)
    registerMethods(console.ctx as never)
    const writesBefore = writesOf(console.world.calls)

    const res = mockRes()
    await console.handlers.get(METHODS_PATH)!(mockReq('GET', `${METHODS_PATH}?graphId=${GRAPH}`), res as never)
    expect(res.statusCode).toBe(200)
    const web = json(res)

    const toolText = (await defineMethodListTool(console.ctx as never).execute({}, console.world.exec as never)) as string

    // The pointer: the tool prints exactly the revision, generation and digest prefix the payload carries.
    const revision = web.environment
    expect(toolText).toContain(`active revision ${revision.revisionId} g${revision.generation} (${revision.manifestDigest.slice(0, 12)})`)

    // The drafts: one line each, same id, status, class, identity, candidate digest and verdict.
    const draft = web.drafts[0]
    expect(toolText).toContain(
      `${draft.draftId} [${draft.status}] ${draft.kind} ${draft.identity} candidate ${draft.candidateRevision.digest.slice(0, 12)} verdict ${draft.evaluation.verdict}`,
    )

    // The verdict the pipeline settled is the report's own, read back by both.
    expect(draft.evaluation.evaluationId).toBe(console.evaluationId)
    expect(console.decision.admissions[0]!.candidateId).toBe(console.draftId)

    // The admission: the refusal the strategy landed, on both surfaces.
    const reasonCode = draft.admission.reasonCode
    expect(draft.admission.admissible).toBe(false)
    expect(web.history.refutations.map((refutation: { reasonCode: string }) => refutation.reasonCode)).toEqual([reasonCode])
    expect(toolText).toContain(reasonCode)

    // The compact history: both fold the same facts, so the same quality, stall count and untouched slots.
    expect(web.history.entries[0].measured).toBe(true)
    expect(web.history.bestQuality).toBe(1)
    expect(toolText).toContain(`best quality ${web.history.bestQuality.toFixed(4)}`)
    expect(toolText).toContain(`rounds without a quality gain ${web.history.roundsWithoutQualityGain}`)
    expect(toolText).toContain(`drafts (${web.drafts.length})`)

    // The evaluator's own projection of the same ledger bytes agrees with both.
    const ledger = await openMethodLedger({ root: console.world.library.root, libraryId: GRAPH })
    const views = draftViews(ledger)
    expect(views.map(view => view.draft.draftId)).toEqual(web.drafts.map((entry: { draftId: string }) => entry.draftId))
    const folded = foldMethods(ledger.records()).get(console.draftId)!
    expect(folded.status).toBe(web.drafts[0].status)
    expect(folded.evaluation?.evaluationId).toBe(web.drafts[0].evaluation.evaluationId)
    expect(folded.draft.candidateRevision.digest).toBe(web.drafts[0].candidateRevision.digest)
    expect(folded.draft.baseRevision.revisionId).toBe(web.drafts[0].baseRevision.revisionId)

    // Neither surface wrote anything: no environment entry that moves a draft or a pointer was reached.
    expect(writesOf(console.world.calls)).toEqual(writesBefore)
  })

  it('agree on a draft the ledger holds without an evaluation as well', async () => {
    const console = await methodConsole()
    opened.push(console.world)
    // A second candidate that was staged and never measured: the console may not
    // show a verdict for it, and the tool's own line must say the same.
    const { defineMethodDraftTool } = await import('../../../agent-singularity/src/tools/method-draft.ts')
    const { skillPayload, DECLARED_EDIT } = await import('../../../agent-singularity/tests/unit/method-tools.fixture.ts')
    const drafted = (await defineMethodDraftTool(console.ctx as never).execute(
      {
        kind: 'skill',
        identity: 'verify',
        edits: [DECLARED_EDIT],
        editPayload: skillPayload('# candidate: never measured'),
        rationale: 'a second mechanism, staged and not measured yet',
        sourceRefs: ['diagnosis:d2'],
        expectedBaseRevision: 'r0001',
        round: 0,
        critic: { verdict: 'accept', reason: 'one mechanism, the asset parses', evidenceRefs: ['diagnosis:d2'] },
      },
      console.world.exec as never,
    )) as string
    const stagedDraftId = /draft (d[0-9]{4})/.exec(drafted)?.[1]
    expect(stagedDraftId).toBeDefined()

    registerMethods(console.ctx as never)
    const res = mockRes()
    await console.handlers.get(METHODS_PATH)!(mockReq('GET', `${METHODS_PATH}?graphId=${GRAPH}`), res as never)
    const web = json(res)
    const toolText = (await defineMethodListTool(console.ctx as never).execute({}, console.world.exec as never)) as string

    const drafts = web.drafts as readonly {
      draftId: string
      status: string
      candidateRevision: { digest: string }
      evaluation: { verdict: string } | null
      admission: unknown
    }[]
    expect(drafts.map(entry => entry.draftId)).toEqual([stagedDraftId, console.draftId])
    expect(toolText).toContain(`drafts (${drafts.length})`)
    for (const entry of drafts) {
      const verdict = entry.evaluation === null ? '' : ` verdict ${entry.evaluation.verdict}`
      expect(toolText).toContain(
        `${entry.draftId} [${entry.status}] skill verify candidate ${entry.candidateRevision.digest.slice(0, 12)}${verdict}`,
      )
    }
    // The unmeasured candidate has no evaluation and no admission to show.
    expect(drafts[0]).toMatchObject({ draftId: stagedDraftId, status: 'draft', evaluation: null, admission: null })
    expect(drafts[1].evaluation).not.toBeNull()
  })
})

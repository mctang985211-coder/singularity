import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it } from 'vitest'
import { createReviewCommands } from '../../src/review/commands.ts'
import { MEASURE_PROTOCOL, MEASURE_VERSION, type EvaluationState } from '../../src/measure/protocol.ts'
import { STRATEGY_PROTOCOL, STRATEGY_VERSION } from '../../src/strategy/protocol.ts'
import { TASK_PROTOCOL, TASK_VERSION } from '../../src/task/protocol.ts'
import { digestOf } from '../../src/protocol/envelope.ts'
import { callerOf, declareCaller, openApparatus, taskStateOf } from '../src/apparatus.ts'
import { loadDomain } from '../src/domain.ts'
import { sha256 } from '../src/ids.ts'
import { readForAgent, readTrajectory } from '../src/read.ts'
import { acceptanceSubject, type FrozenRsiEvidence } from '../src/review.ts'
import { textPage } from '../src/pages.ts'
import { spawnProcess } from '../src/process.ts'
import { propose } from '../src/surfaces.ts'
import { attachmentsAt, agentFor, FakePersistence, testProjections } from './seam.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const event = (seq: number, text: string): SessionEvent => ({ seq: SessionSeq(seq), time: seq, surfaceOp: 'append',
  type: 'assistant/message', data: { turn: 1, step: 1, stream: [],
    message: createAssistantMessage({ source: { provider: 'test', model: 'test' }, content: [{ type: 'text', text }] }) } })

it('reviews RSI reports against sealed source and search evidence at submission, excluding private, unrelated and later observations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-report-evidence-')); roots.push(root)
  const apparatus = await openApparatus('report-scope', root,
    await loadDomain(fileURLToPath(new URL('../../deployment/domain/letters', import.meta.url)), spawnProcess),
    new FakePersistence() as never, attachmentsAt(root), testProjections)
  try {
    const contract = { goal: 'Produce an evidenced report', artifact: 'report.json', inputs: [],
      criteria: [{ criterionId: 'accurate', statement: 'Report only actual observations.' }] }
    const businessCaller = callerOf(agentFor('business', 'business'))
    const business = await propose(apparatus, businessCaller, 'business', { contract, learning: false })
    await apparatus.tasks.forAgent(businessCaller.agentId).failRun({ commandId: 'business-failed', taskId: business.taskId,
      runId: business.runId, cause: 'business', reason: 'A useful investigation failed.' })
    const taskFact = (commandId: string, taskId: string, kind: string, payload: unknown, as?: string) => apparatus.store.emit({
      commandId, subject: taskId, protocol: TASK_PROTOCOL, version: TASK_VERSION, kind, payload,
      ...(as === undefined ? {} : { as }),
    })
    await taskFact('business-closed', business.taskId, 'task/closed', { runId: business.runId, reason: 'failed' }, 'agent:business')
    const trace = async (sessionId: string, text: string) => apparatus.attachments.saveFile({ name: 'trajectory.json',
      data: Buffer.from(JSON.stringify({ sessions: [{ sessionId, events: [event(0, text)] }] })) })
    const sourceTrace = await trace('business-child', 'The sealed business failure is evidence.')
    await taskFact('rsi-pending', business.taskId, 'rsi/status', { status: 'pending', detail: 'Prepare evidence.' })
    await taskFact('rsi-running', business.taskId, 'rsi/status', { status: 'running', detail: 'Source sealed.', trace: sourceTrace })
    const author = callerOf(agentFor('analysis', 'analysis'))
    const analysis = await propose(apparatus, author, 'analysis', { contract, learning: false },
      { purpose: 'improve', relatedTo: { taskId: business.taskId, runId: business.runId } })
    const method = taskStateOf(apparatus, analysis.taskId).runs[analysis.runId]!.revision
    await taskFact('search-opened', analysis.taskId, 'rsi/search-opened', { runId: analysis.runId, maxProposals: 6 }, 'agent:analysis')
    const citation = (sessionId: string): FrozenRsiEvidence['citations'][number] => ({
      reference: { rootId: 'old-root', sessionId, eventSeq: 7, from: 32, count: 64 },
      page: { seq: 7, type: 'assistant/message', ...textPage(Buffer.from(JSON.stringify(event(7, 'Historical witness.'), null, 2)), 32, 64) },
    })
    const cited = citation('old-child'), foreign = citation('foreign-history'), later = citation('after-report-history')
    const revisions = ['1', '2'].map(digit => ({ ...method, revisionId: 'candidate-' + digit, digest: digit.repeat(64) }))
    const slots = await Promise.all(revisions.map(async (_revision, slot) => {
      const bytes = Buffer.from(JSON.stringify({ slot }))
      return { path: `proposal-${slot}.json`, contentDigest: sha256(bytes),
        proposal: await apparatus.attachments.saveFile({ name: `proposal-${slot}.json`, data: bytes }) }
    }))
    await taskFact('batch-opened', analysis.taskId, 'rsi/batch-opened', { batchId: 'batch', incumbent: method,
      editBudget: 1, historyCutoff: apparatus.store.load().entries().length, untried: [], prune: false, slots }, 'agent:analysis')
    for (const [slot, revision] of revisions.entries()) await taskFact(`batch-slot-${slot}`, analysis.taskId, 'rsi/batch-slot-settled', {
      batchId: 'batch', slot, revision, status: 'screen-failed', detail: 'No measured candidate.' }, 'agent:analysis')
    await taskFact('batch-ended', analysis.taskId, 'rsi/batch-ended', { batchId: 'batch' }, 'agent:analysis')
    const proposalReview = async (taskId: string, digest: string, nativeEvidence: FrozenRsiEvidence['citations']) => {
      const reviewId = `review-${sha256(`${apparatus.controlId}/proposal:${taskId}:${digest}`).slice(0, 24)}`
      const identity = declareCaller(apparatus, reviewId)
      await apparatus.agents.open({ commandId: `agent:${reviewId}`, agentId: reviewId, sessionId: reviewId, role: 'review' })
      const bytes = Buffer.from(JSON.stringify({ purpose: 'proposal', nativeEvidence }))
      await createReviewCommands(apparatus.store).start(`start:${reviewId}`, reviewId, {
        target: { kind: 'proposal', environmentId: method.environmentId, revisionId: 'candidate', assetsDigest: digest },
        subject: await apparatus.attachments.saveFile({ name: 'subject.json', data: bytes }), subjectDigest: sha256(bytes),
        criteria: contract.criteria, agentId: reviewId, sessionId: reviewId, identity: apparatus.store.identityOf(identity)!,
        workspace: join(root, reviewId), model: taskStateOf(apparatus, analysis.taskId).runs[analysis.runId]!.bubble!.model, method,
      })
    }
    await proposalReview(analysis.taskId, revisions[0]!.digest, [cited, cited])
    await proposalReview('other-search', '3'.repeat(64), [foreign])
    await taskFact('round-requested', analysis.taskId, 'rsi/round-requested', {
      runId: analysis.runId, roundId: 'round', round: 1, incumbent: method, candidates: [method],
    }, 'agent:analysis')
    await apparatus.store.emit({ commandId: 'strategy-round', subject: 'round', protocol: STRATEGY_PROTOCOL, version: STRATEGY_VERSION,
      kind: 'round/opened', payload: { campaignId: analysis.taskId, round: 1, incumbent: method, candidates: 1,
        historyCutoff: apparatus.store.load().entries().length, caliber: 'c'.repeat(64), weights: { quality: 1, cost: 1 } } })
    const verifier = apparatus.domain.verifiers[0]!
    const metric = { measured: { criterionId: 'quality', statement: 'Independent quality', verifierRef: verifier.ref,
      verifierVersion: verifier.version, implementationDigest: verifier.implementationDigest }, unit: 'pass', direction: 'higher' }
    const evaluation = async (id: string, sessionId: string, split: 'evolve' | 'validation' = 'evolve') => {
      const trajectory = await trace(sessionId, 'Frozen measurement evidence: ' + sessionId)
      await apparatus.store.emit({ commandId: id + ':open', subject: id, protocol: MEASURE_PROTOCOL, version: MEASURE_VERSION,
        kind: 'evaluation/opened', payload: { baseline: method, candidate: method,
          run: { taskId: 'trial:' + id, runId: 'trial-run' }, context: 'c'.repeat(64), metric, weights: { quality: 1, cost: 1 }, trials: 2, judgement: [],
          matrix: { suiteDigest: 'd'.repeat(64), executionProfileDigest: 'e'.repeat(64), split,
            slots: [0, 1].map(trial => ({ caseId: 'case', familyId: 'family', contractDigest: 'f'.repeat(64), trial, weight: 0.5 })) } } })
      const record = (slot: number, attachment = trajectory) => apparatus.store.emit({ commandId: `${id}:trial:${slot}`,
        subject: id, protocol: MEASURE_PROTOCOL, version: MEASURE_VERSION, kind: 'trial/recorded', payload: {
          slot, quality: 1, cost: 10, artifactDigest: 'a'.repeat(64), inputDigests: [], guardsMet: true,
          verifierRef: verifier.ref, verifierVersion: verifier.version, implementationDigest: verifier.implementationDigest,
          detail: JSON.stringify({ taskId: 'trial:' + id, trajectory: attachment }),
        } })
      await record(0)
      return { record }
    }
    const baseline = await evaluation('round:bootstrap:evaluation', 'evolve-child')
    await evaluation('round:1:candidate:evaluation', 'private-child', 'validation')
    await evaluation('other:bootstrap:evaluation', 'other-search-child')
    await taskFact('round-settled', analysis.taskId, 'rsi/round-settled', { roundId: 'round', status: 'failed', error: 'One trial was unavailable.' })
    expect(await readTrajectory(apparatus, author.agentId, 'business-child', 0, 8192, 0)).toMatchObject({ text: expect.stringContaining('sealed business failure') })
    expect(await readForAgent(apparatus, author.agentId, { kind: 'trajectory', rootId: business.taskId,
      ref: 'business-child', eventSeq: 0 })).toMatchObject({ text: expect.stringContaining('sealed business failure') })
    expect(await readTrajectory(apparatus, author.agentId, 'evolve-child', 0, 8192, 0)).toMatchObject({ text: expect.stringContaining('Frozen measurement') })
    for (const session of ['private-child', 'other-search-child'])
      await expect(readTrajectory(apparatus, author.agentId, session)).rejects.toThrow('outside the frozen evidence scope')

    const bytes = Buffer.from(JSON.stringify({ summary: 'One incomplete comparison; insufficient evidence.', results: [] }))
    const artifact = await apparatus.attachments.saveFile({ name: 'report.json', data: bytes })
    await apparatus.tasks.forAgent(author.agentId).submitRun({ commandId: 'report-sealed', taskId: analysis.taskId, runId: analysis.runId,
      submission: { requestId: 'report', requestDigest: sha256(bytes), artifactDigest: sha256(bytes), inputDigests: [],
        files: { artifact, inputs: [] }, source: { sessionId: author.sessionId, eventCount: 0,
          digest: digestOf({ sessionId: author.sessionId, eventCount: 0, events: [] }) } } })
    const reportCutoff = apparatus.store.load().entries().length
    // Recovered acceptance may be prepared after further host work, but must keep the submission cut.
    await proposalReview(analysis.taskId, revisions[1]!.digest, [later])
    await baseline.record(1, await trace('later-child', 'Only recorded after report submission.'))
    await evaluation('round:2:candidate:evaluation', 'later-evaluation')
    const run = taskStateOf(apparatus, analysis.taskId).runs[analysis.runId]!
    const subject = await acceptanceSubject(apparatus, analysis.taskId, run, [])
    expect(subject.rsiEvidence).toMatchObject({ cutoff: reportCutoff, rootId: business.taskId, sourceTrace,
      rounds: [{ request: { roundId: 'round', status: 'failed' }, evaluations: [{ evaluationId: 'round:bootstrap:evaluation', observed: [{ slot: 0 }] }] }] })
    expect(JSON.stringify(subject.rsiEvidence)).not.toMatch(/private-child|other-search-child|later-child|later-evaluation|foreign-history|after-report-history/)
    expect(subject.rsiEvidence!.citations).toEqual([cited])
    expect(subject.rsiEvidence!.rounds[0]!.evaluations[0]!.observed).toHaveLength(1)
    const reviewerId = 'reviewer', identity = declareCaller(apparatus, reviewerId)
    await apparatus.agents.open({ commandId: 'reviewer-open', agentId: reviewerId, sessionId: reviewerId, role: 'review' })
    const subjectBytes = Buffer.from(JSON.stringify(subject))
    await createReviewCommands(apparatus.store).start('review-start', 'report-review', {
      target: { kind: 'acceptance', taskId: analysis.taskId, runId: analysis.runId,
        contractDigest: taskStateOf(apparatus, analysis.taskId).contractDigest!, artifactDigest: sha256(bytes) },
      subject: await apparatus.attachments.saveFile({ name: 'subject.json', data: subjectBytes }), subjectDigest: sha256(subjectBytes),
      criteria: contract.criteria, agentId: reviewerId, sessionId: reviewerId, identity: apparatus.store.identityOf(identity)!,
      workspace: join(root, 'review'), model: run.bubble!.model, method,
    })
    const reading = { ...apparatus, persistence: { open: async () => { throw new Error('No live transcript reads allowed in this fixture') } } as never }
    for (const session of ['business-child', 'evolve-child']) {
      expect(await readForAgent(reading, reviewerId, { kind: 'trajectory', ref: session, eventSeq: 0 })).toMatchObject({ seq: 0, complete: true })
      expect(await readForAgent(reading, reviewerId, { kind: 'trajectory', rootId: business.taskId,
        ref: session, eventSeq: 0 })).toMatchObject({ seq: 0, complete: true })
      await expect(readForAgent(reading, reviewerId, { kind: 'trajectory', rootId: 'historical-unsealed',
        ref: session, eventSeq: 0 })).rejects.toThrow('rootId is outside the frozen evidence scope')
      await expect(readTrajectory(reading, reviewerId, session, 0, 8192, 1)).rejects.toThrow('outside this readable trajectory')
    }
    for (const session of ['private-child', 'other-search-child', 'later-child', 'later-evaluation'])
      await expect(readTrajectory(reading, reviewerId, session)).rejects.toThrow('outside the frozen evidence scope')
    const historical = { kind: 'trajectory' as const, rootId: 'old-root', ref: 'old-child', eventSeq: 7, from: 32, count: 64 }
    expect(await readForAgent(reading, reviewerId, historical)).toEqual(cited.page)
    expect(await readTrajectory(reading, reviewerId, 'old-child', 32, 64, 7)).toEqual(cited.page)
    expect(await readForAgent(reading, reviewerId, { ...historical, from: 40, count: 16 })).toMatchObject({
      from: 40, next: 56, complete: false, text: Buffer.from(cited.page.text).subarray(8, 24).toString('utf8') })
    for (const override of [{ rootId: 'wrong-root' }, { eventSeq: 8 }, { from: 0 }, { from: cited.page.next },
      { ref: 'foreign-history' }, { ref: 'after-report-history' }])
      await expect(readForAgent(reading, reviewerId, { ...historical, ...override })).rejects.toThrow('outside the frozen evidence scope')
    for (const session of ['foreign-history', 'after-report-history'])
      await expect(readTrajectory(reading, reviewerId, session, 32, 64, 7)).rejects.toThrow('outside the frozen evidence scope')
    const round = await readForAgent(reading, reviewerId, { kind: 'round', ref: 'round' }) as { evaluations: EvaluationState[]; publication: null }
    expect(round.publication).toBeNull()
    expect(round.evaluations).toHaveLength(1)
    expect(round.evaluations[0]!.observed).toHaveLength(1)
    await expect(readForAgent(reading, reviewerId, { kind: 'round', ref: 'other' })).rejects.toThrow('outside this frozen evidence scope')
    const refrozen = await acceptanceSubject(apparatus, analysis.taskId, run, [])
    expect(refrozen.rsiEvidence).toEqual(subject.rsiEvidence)
  } finally { await apparatus.store.close() }
})

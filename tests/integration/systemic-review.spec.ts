/**
 * Systemic review on the real DSH loop, TaskRuntime, verifiers and tools.
 * The provider is ScriptedModelAdapter: these are deterministic integration
 * tests of authority, persisted lineage and coordination, not live-model tests.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  consumePendingHandoffs,
  installSupervisorHandoffTrigger,
} from '../../agent-singularity/src/coordination/evolution-handoff.ts'
import { readReviewAgentAttempts } from '../../agent-singularity/src/coordination/ledger.ts'
import {
  installReviewAgentAutoTrigger,
  scanFailedReviewSources,
} from '../../agent-singularity/src/coordination/review-scan.ts'
import { rootTaskStoreId } from '../../task/src/index.ts'
import type { TaskSnapshot } from '../../task/src/index.ts'
import {
  disposeScriptedLoops,
  startScriptedLoop,
  type ScriptEntry,
  type ScriptedLoop,
} from '../support/scripted-loop.ts'

const ROOT = 's-root' as SessionId
const STORE = rootTaskStoreId(String(ROOT))
const SIGNING_CHECK = `node -e "const c=require('./release-config.json');if(!c.signature){console.error('shared-config: signature is missing');process.exit(1)}"`
const DOCS_CHECK = `node -e "const c=require('./release-config.json');if(!c.docsReady)process.exit(1);console.log('control: docs configuration is ready')"`
const ROOT_CONTRACT = {
  objective: 'ship independent release outputs',
  requiredCapabilities: ['execute-task'],
  acceptanceCriteria: [
    { criterionId: 'root-goal', description: 'release coordination is complete', command: 'true' },
    { criterionId: 'root-members', description: 'all outputs pass their own checks', mode: 'composite', mandatory: true },
  ],
}
const OUTPUTS = ['signed linux release', 'signed darwin release', 'release documentation']

beforeEach(() => {
  vi.stubEnv('SINGULARITY_REVIEW_LEDGER_DIR', '')
  vi.stubEnv('SINGULARITY_REVIEW_AGENT_BUDGET', '')
})

afterEach(async () => {
  await disposeScriptedLoops()
  vi.unstubAllEnvs()
})

/** These refs come from real task/run records, with review evidence once settled. */
function members(snapshot: TaskSnapshot, rootTaskId: string) {
  return snapshot.tasks.filter(task => task.parentTaskId === rootTaskId).map(task => {
    const run = snapshot.runs.find(candidate => candidate.taskId === task.taskId)
    const review = snapshot.reviews.find(candidate => candidate.runId === run?.runId)
    return {
      taskId: task.taskId,
      runId: run?.runId ?? '',
      sessionId: run?.sessionId ?? '',
      objective: task.objective,
      reviewRef: `${task.taskId}#${run?.runId ?? ''}`,
      evidenceRefs: review?.evidenceRefs ?? [],
    }
  })
}

async function ended(h: ScriptedLoop, runId: string, status: 'failed' | 'verified') {
  await vi.waitFor(async () => {
    expect((await h.snapshot(STORE)).runs.find(run => run.runId === runId)?.status).toBe(status)
  }, { timeout: 30_000, interval: 25 })
}

function reply(value: Record<string, unknown>): ScriptEntry {
  return { text: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` }
}

describe('systemic review with a scripted provider and real runtime/tools', () => {
  it('links independent failures and a successful control, lets one supervisor investigate, and never nests that investigation', async () => {
    const published = Promise.withResolvers<void>()
    const releaseRoot = Promise.withResolvers<void>()
    const beginReview = Promise.withResolvers<void>()
    let rootTaskId = ''
    let peers: ReturnType<typeof members> = []
    let h!: ScriptedLoop
    h = await startScriptedLoop({
      supervision: { autoReview: 'off', coordinationBudget: 8 },
      script: (sessionId, index) => {
        const name = h.spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
        if (name.startsWith('supervisor for ')) {
          const source = h.spawns.find(spawn => spawn.name.startsWith('review '))!
          return [
            { tool: 'task_status', args: { scope: 'graph' } },
            { tool: 'context_read', args: { kind: 'diagnosis', ref: `review-agent-${source.sessionId}` } },
            {
              tool: 'task_review_agent',
              args: { taskId: peers[1]!.taskId, runId: peers[1]!.runId, requestKey: 'darwin-signing-focus', reason: 'Check whether darwin failed from the same missing signature as linux; cite both checks.' },
            },
            {
              tool: 'task_review_agent',
              args: { taskId: peers[2]!.taskId, runId: peers[2]!.runId, requestKey: 'docs-control-focus', reason: 'Use the successful docs task as counterevidence: establish which configuration and acceptance remain unaffected.' },
            },
            ...[1, 2].map(ordinal => ({
              tool: 'context_read',
              args: () => ({ kind: 'diagnosis', ref: `review-agent-${h.spawns.filter(spawn => spawn.name.startsWith('review '))[ordinal]!.sessionId}` }),
            })),
            reply({ outcome: 'closed', reason: 'The focused reports confirm the shared signature defect in two builds and successful independent docs; the investigation is complete.' }),
          ]
        }
        if (name.startsWith('review ')) {
          const ordinal = h.spawns.filter(spawn => spawn.name.startsWith('review ')).length - 1
          const own = ordinal === 0 ? peers[0]! : peers[ordinal]!
          const readings: ScriptEntry[] = [
            { tool: 'task_status', args: { scope: 'graph' } },
            ...peers.filter(peer => peer.taskId !== own.taskId).flatMap(peer => [
              { tool: 'context_read', args: { kind: 'task', ref: peer.taskId } },
              { tool: 'context_read', args: { kind: 'review', ref: { taskId: peer.taskId, runId: peer.runId } } },
              { tool: 'context_read', args: { kind: 'evidence', ref: peer.evidenceRefs[0]! } },
              { tool: 'context_read', args: { kind: 'session', ref: peer.sessionId, limit: 100 } },
            ]),
          ]
          return [...readings, reply({
            observation: ordinal === 2
              ? 'The docs control passed its real docsReady check while both signing checks failed.'
              : 'Both independent signing commands failed with shared-config: signature is missing; docs passed.',
            conclusion: ordinal === 2
              ? 'The successful docs output excludes a whole-environment failure; signing configuration is the affected scope.'
              : 'The two builds share the missing signing configuration; inspect that shared setup rather than treating them as unrelated output failures.',
            confidence: 'high',
            scope: 'shared signing configuration across independent build tasks',
            reviewRefs: [own.reviewRef, ...peers.filter(peer => peer.taskId !== own.taskId).map(peer => peer.reviewRef)],
            evidenceRefs: peers.flatMap(peer => peer.evidenceRefs),
            relatedTaskIds: peers.slice(0, 2).filter(peer => peer.taskId !== own.taskId).map(peer => peer.taskId),
            // A supervisor-requested report carrying a proposal is still a
            // report to its caller; it must not create another supervisor.
            proposals: ordinal === 2 ? [] : [{ targetType: 'capability', targetId: 'release-signing', rationale: 'Both builds lack the shared signing setup, while the docs control is unaffected.' }],
          })]
        }
        if (index === 0) return [
          {
            tool: 'task_decompose',
            args: {
              reason: 'Produce three independently accepted release outputs',
              children: OUTPUTS.map((objective, position) => ({
                objective,
                requiredCapabilities: ['execute-task'],
                acceptanceCriteria: [{ criterionId: `output-${position}`, description: 'the output configuration is valid', command: position === 2 ? DOCS_CHECK : SIGNING_CHECK }],
              })),
            },
          },
          { text: 'The independent output batch is running.' },
          { waitFor: () => releaseRoot.promise },
          { tool: 'task_submit_result', args: { summary: 'The release outputs have been checked.' } },
          { text: 'The failed release is ready for review.' },
          { waitFor: () => beginReview.promise },
          { tool: 'task_review_agent', args: () => ({ taskId: peers[0]!.taskId, runId: peers[0]!.runId, reason: 'Compare independent signing failures with the successful documentation control.' }) },
          { text: 'The systemic review was recorded.' },
        ]
        return [
          { waitFor: () => published.promise },
          // A worker gets no extra authority merely because its reviewer will
          // later need to compare that same sibling.
          ...(index === 3 ? [
            { tool: 'context_read', args: () => ({ kind: 'task', ref: peers[1]!.taskId }) },
            { tool: 'context_read', args: () => ({ kind: 'session', ref: h.spawns[1]!.sessionId }) },
          ] : []),
          { tool: 'task_submit_result', args: { summary: `${OUTPUTS[index - 1]} submitted for its real command check` } },
          { text: 'Output submitted.' },
        ]
      },
    })
    writeFileSync(join(h.checkout, 'release-config.json'), JSON.stringify({ docsReady: true }))
    const root = await h.begin(ROOT_CONTRACT)
    rootTaskId = root.taskId
    await vi.waitFor(async () => {
      peers = members(await h.snapshot(STORE), rootTaskId)
      expect(peers).toHaveLength(3)
    }, { timeout: 30_000, interval: 25 })
    published.resolve()
    await vi.waitFor(async () => {
      peers = members(await h.snapshot(STORE), rootTaskId)
      expect(peers.every(peer => peer.runId.length > 0)).toBe(true)
    }, { timeout: 30_000, interval: 25 })
    const batchId = (await h.snapshot(STORE)).runs.find(run => run.runId === root.runId)!.batchId!
    const outcomes = await h.runtime.awaitBatch(STORE, batchId)
    expect(outcomes.map(outcome => outcome.status)).toEqual(['failed', 'failed', 'verified'])
    const terminal = await h.snapshot(STORE)
    peers = members(terminal, rootTaskId)
    expect(terminal.edges).toHaveLength(0)
    expect(peers.every(peer => peer.evidenceRefs.length > 0)).toBe(true)
    const denied = h.calls.filter(call => call.sessionId === peers[2]!.sessionId && call.name === 'context_read')
    expect(denied).toHaveLength(2)
    expect(denied.every(call => call.result?.text.startsWith('context_read not-found:'))).toBe(true)
    expect(denied[1]!.result!.text).toContain('outside the caller\'s task branch')
    releaseRoot.resolve()
    await ended(h, root.runId, 'failed')
    beginReview.resolve()
    h.userSays('Compare the failed signing outputs and the successful docs control.', ROOT)

    await vi.waitFor(async () => {
      const attempts = await readReviewAgentAttempts(STORE)
      expect(attempts.filter(attempt => attempt.role === 'reviewer' && attempt.settlement?.status === 'recorded')).toHaveLength(3)
      expect(attempts.filter(attempt => attempt.role === 'supervisor' && attempt.settlement?.status === 'closed')).toHaveLength(1)
    }, { timeout: 30_000, interval: 25 })
    const reviewers = h.spawns.filter(spawn => spawn.name.startsWith('review '))
    const supervisors = h.spawns.filter(spawn => spawn.name.startsWith('supervisor for '))
    expect(supervisors).toHaveLength(1)
    const supervisor = supervisors[0]!
    expect(h.visible(h.agent(supervisor.sessionId))).toContain('task_review_agent')
    const investigations = h.calls.filter(call => call.sessionId === supervisor.sessionId && call.name === 'task_review_agent')
    expect(investigations).toHaveLength(2)
    expect(investigations.every(call => call.result?.isError === false && call.result.text.includes('diagnosis'))).toBe(true)
    expect(investigations.map(call => (call.args as { taskId: string }).taskId)).toEqual([peers[1]!.taskId, peers[2]!.taskId])
    const source = reviewers[0]!
    const sourceReads = h.calls.filter(call => call.sessionId === source.sessionId && call.name === 'context_read')
    expect(sourceReads).toHaveLength(8)
    expect(sourceReads.every(call => call.result?.isError === false)).toBe(true)
    for (const call of sourceReads) expect(call.result?.text).not.toMatch(/^context_read (not-found|cross-graph|unreadable|binding-conflict):/)
    expect(sourceReads.find(call => (call.args as { kind: string; ref: unknown }).kind === 'evidence')?.result?.text).toContain('shared-config: signature is missing')
    expect(sourceReads.filter(call => (call.args as { kind: string }).kind === 'session').map(call => call.result!.text).join('\n')).toContain('submitted for its real command check')
    for (const reviewer of reviewers) {
      const surface = h.visible(h.agent(reviewer.sessionId))
      for (const forbidden of ['write', 'edit', 'bash', 'task_review_agent', 'task_submit_result']) expect(surface).not.toContain(forbidden)
    }
    const snapshot = await h.snapshot(STORE)
    const diagnosis = snapshot.diagnoses.find(item => item.diagnosisId === `review-agent-${source.sessionId}`)!
    expect(diagnosis.scope).toBe('shared signing configuration across independent build tasks')
    expect(diagnosis.reviewRefs).toEqual(peers.map(peer => peer.reviewRef))
    expect(diagnosis.evidenceRefs).toEqual(peers.flatMap(peer => peer.evidenceRefs))
    expect(diagnosis.relatedTaskIds).toEqual([peers[1]!.taskId])
    const firstSupervisorRequest = h.requestsOf(supervisor.sessionId)[0]!.texts.join('\n')
    for (const ref of [...diagnosis.reviewRefs, ...diagnosis.evidenceRefs, ...diagnosis.relatedTaskIds!]) expect(firstSupervisorRequest).toContain(ref)
    expect(firstSupervisorRequest).toContain(diagnosis.scope)
    const finalSupervisorRequest = h.requestsOf(supervisor.sessionId).at(-1)!.texts.join('\n')
    for (const objective of OUTPUTS) expect(finalSupervisorRequest).toContain(objective)
    expect(finalSupervisorRequest).toContain('successful docs output excludes a whole-environment failure')
    expect(finalSupervisorRequest).toContain(`review-agent-${reviewers[1]!.sessionId}`)
    expect(finalSupervisorRequest).toContain(`review-agent-${reviewers[2]!.sessionId}`)
    const attempts = await readReviewAgentAttempts(STORE)
    expect(attempts.filter(attempt => attempt.role === 'reviewer' && attempt.actor === supervisor.sessionId)).toHaveLength(2)

    // Re-reading durable reports and graph activation must not convert the
    // supervisor's own focused reviewers into new supervisor hand-offs.
    const before = h.spawns.length
    const scan = await consumePendingHandoffs(h.ctx, STORE)
    expect(scan.consumptions).toEqual([expect.objectContaining({ diagnosisId: diagnosis.diagnosisId, result: 'existing', sessionId: supervisor.sessionId })])
    const lines: string[] = []
    const stop = installSupervisorHandoffTrigger(h.ctx, { log: line => lines.push(line) })
    try {
      h.ctx.emit('graphs/selected' as never, { rootSessionId: String(ROOT), id: 'g1' } as never)
      await vi.waitFor(() => expect(lines.some(line => line.includes('already delegated'))).toBe(true), { timeout: 30_000, interval: 25 })
      expect(h.spawns).toHaveLength(before)
      expect(await readReviewAgentAttempts(STORE)).toEqual(attempts)
    } finally {
      stop()
    }
  })

  it('spends automatic review allowance only after root acceptance, reviews the whole graph once, and permits an explicit leaf review', async () => {
    const releaseRoot = Promise.withResolvers<void>()
    const explicitLeaf = Promise.withResolvers<void>()
    let rootTaskId = ''
    let peers: ReturnType<typeof members> = []
    let h!: ScriptedLoop
    h = await startScriptedLoop({
      // Leave autoReview unspecified: this case exercises the shipped default.
      supervision: { coordinationBudget: 2 },
      script: (sessionId, index) => {
        const name = h.spawns.find(spawn => spawn.sessionId === sessionId)?.name ?? ''
        if (name.startsWith('supervisor for ')) return [{ hang: true }]
        if (name.startsWith('review ')) return [
          { tool: 'task_status', args: { scope: 'graph' } },
          reply({ observation: 'Every independently checked release output passed.', conclusion: 'No improvement needed; the accepted graph has no justified change.', confidence: 'high' }),
        ]
        if (index === 0) return [
          {
            tool: 'task_decompose',
            args: { reason: 'Produce independent accepted outputs', children: OUTPUTS.map((objective, position) => ({ objective, requiredCapabilities: ['execute-task'], acceptanceCriteria: [{ criterionId: `output-${position}`, description: 'output is ready', command: 'true' }] })) },
          },
          { text: 'The output batch is running.' },
          { waitFor: () => releaseRoot.promise },
          { tool: 'task_submit_result', args: { summary: 'All release outputs passed.' } },
          { text: 'The accepted release is complete.' },
          { waitFor: () => explicitLeaf.promise },
          { tool: 'task_review_agent', args: () => ({ taskId: peers[0]!.taskId, runId: peers[0]!.runId, reason: 'An explicit focused review of the successful linux output.' }) },
          { text: 'Explicit output review complete.' },
        ]
        return [{ tool: 'task_submit_result', args: { summary: 'Output ready for acceptance.' } }, { text: 'Output submitted.' }]
      },
    })
    const stop = installReviewAgentAutoTrigger(h.ctx)
    try {
      const root = await h.begin(ROOT_CONTRACT)
      rootTaskId = root.taskId
      const batchId = await vi.waitFor(async () => {
        const id = (await h.snapshot(STORE)).runs.find(run => run.runId === root.runId)?.batchId
        expect(id).toBeDefined()
        return id!
      }, { timeout: 30_000, interval: 25 })
      expect((await h.runtime.awaitBatch(STORE, batchId)).map(outcome => outcome.status)).toEqual(['verified', 'verified', 'verified'])
      peers = members(await h.snapshot(STORE), rootTaskId)
      const beforeAcceptance = await scanFailedReviewSources(h.ctx, STORE)
      expect(beforeAcceptance.entries).toEqual([])
      expect(await readReviewAgentAttempts(STORE)).toEqual([])
      expect(h.spawns.filter(spawn => spawn.name.startsWith('review '))).toHaveLength(0)
      releaseRoot.resolve()
      await ended(h, root.runId, 'verified')
      await vi.waitFor(async () => expect((await h.snapshot(STORE)).diagnoses).toHaveLength(1), { timeout: 30_000, interval: 25 })
      const autoReviewer = h.spawns.find(spawn => spawn.name === `review ${rootTaskId}`)!
      expect(autoReviewer).toBeDefined()
      const rootPack = h.requestsOf(autoReviewer.sessionId)[0]!.texts.join('\n')
      for (const peer of peers) {
        expect(rootPack).toContain(peer.taskId)
        expect(rootPack).toContain(peer.reviewRef)
      }
      const again = await scanFailedReviewSources(h.ctx, STORE)
      expect(again.entries).toEqual([expect.objectContaining({ source: { taskId: rootTaskId, runId: root.runId }, result: 'existing', sessionId: autoReviewer.sessionId })])
      expect((await readReviewAgentAttempts(STORE)).filter(attempt => attempt.started)).toHaveLength(1)
      expect(h.spawns.filter(spawn => spawn.name.startsWith('supervisor for '))).toHaveLength(0)
      expect((await consumePendingHandoffs(h.ctx, STORE)).consumptions).toEqual([])

      explicitLeaf.resolve()
      h.userSays('Review the successful linux output explicitly.', ROOT)
      await vi.waitFor(async () => expect((await h.snapshot(STORE)).diagnoses).toHaveLength(2), { timeout: 30_000, interval: 25 })
      const attempts = await readReviewAgentAttempts(STORE)
      expect(attempts.filter(attempt => attempt.started)).toHaveLength(2)
      expect(attempts.filter(attempt => attempt.role === 'supervisor')).toEqual([])
      expect(attempts.map(attempt => attempt.source.taskId)).toEqual([rootTaskId, peers[0]!.taskId])
      const explicit = h.calls.find(call => call.sessionId === ROOT && call.name === 'task_review_agent')!
      expect(explicit.result?.isError).toBe(false)
      expect(explicit.result?.text).toContain('diagnosis')
      expect(h.spawns.filter(spawn => spawn.name.startsWith('review '))).toHaveLength(2)
      expect((await consumePendingHandoffs(h.ctx, STORE)).consumptions).toEqual([])
    } finally {
      stop()
    }
  })
})

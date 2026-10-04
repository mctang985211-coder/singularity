/** Self-check and submission judge the replay workspace, even when the source checkout disagrees. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { disposeScriptedLoops, startScriptedLoop } from '../support/scripted-loop.ts'

const ROOT = 's-root'
afterEach(async () => { await disposeScriptedLoops() })

it.each([
  { original: 'wrong', replay: 'accepted', status: 'verified', verdict: 'pass' },
  { original: 'accepted', replay: 'wrong', status: 'failed', verdict: 'fail' },
] as const)('checks the replay when original=$original and replay=$replay', async ({ original, replay, status, verdict }) => {
  const h = await startScriptedLoop({
    tools: [], supervision: { autoReview: 'off' },
    script: sessionId => sessionId === ROOT ? [
      { tool: 'task_submit_result', args: { summary: 'original answer' } }, { text: 'done' },
    ] : [
      { tool: 'task_verify' },
      { tool: 'task_submit_result', args: { summary: 'replayed answer' } }, { text: 'done' },
    ],
  })
  writeFileSync(join(h.checkout, 'answer.txt'), original)
  const source = await h.begin({
    objective: 'deliver the accepted answer', requiredCapabilities: ['execute-task'],
    acceptanceCriteria: [{ criterionId: 'answer', description: 'the answer is accepted', command: 'pwd && test "$(cat answer.txt)" = accepted' }],
  })
  await h.agent(ROOT).whenIdle()
  const before = await h.snapshot(source.storeId)
  expect(before.runs.find(run => run.runId === source.runId)?.status).toBe(status === 'verified' ? 'failed' : 'verified')

  const workspace = join(h.workspace, 'replay')
  mkdirSync(workspace)
  writeFileSync(join(workspace, 'answer.txt'), replay)
  const outcome = await h.runtime.replayTask(source.storeId, source.taskId, { lineage: 'self-check-workspace', workspace: { path: workspace } }, ROOT)
  expect(outcome.status).toBe(status)
  const after = await h.snapshot(source.storeId)
  const run = after.runs.find(item => item.runId === outcome.runId)!
  const selfCheck = h.calls.find(call => call.sessionId === run.sessionId && call.name === 'task_verify')!
  const submission = h.calls.find(call => call.sessionId === run.sessionId && call.name === 'task_submit_result')!
  expect(selfCheck.result?.isError).toBe(false)
  expect(selfCheck.result?.text).toContain(`- answer: ${verdict} by command`)
  expect(submission.result?.text).toContain(`task_submit_result ${status}:`)

  const evidence = after.evidence.filter(bundle => bundle.taskRunId === outcome.runId)
  expect(evidence).toHaveLength(2)
  expect(selfCheck.result?.text).toContain(evidence[0]!.evidenceId)
  for (const bundle of evidence) {
    expect(bundle.taskId).toBe(run.taskId)
    expect(bundle.verifierResults.map(result => result.status)).toEqual([verdict])
    const logRef = bundle.verifierResults[0]!.logRef!
    expect(logRef).toBe(`${source.storeId}/${outcome.runId}/answer.log`)
    const log = readFileSync(join(h.verifier.evidenceRoot, logRef), 'utf8')
    expect(log).toContain(workspace)
    expect(log).not.toContain(h.checkout)
  }
  expect(after.tasks.find(task => task.taskId === source.taskId)).toEqual(before.tasks.find(task => task.taskId === source.taskId))
  expect(after.runs.find(item => item.runId === source.runId)).toEqual(before.runs.find(item => item.runId === source.runId))
  expect(after.reviews.filter(review => review.taskId === source.taskId)).toEqual(before.reviews.filter(review => review.taskId === source.taskId))
  expect(readFileSync(join(h.checkout, 'answer.txt'), 'utf8')).toBe(original)
})
